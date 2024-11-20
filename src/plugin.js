import videojs from 'video.js';
import window from 'global/window';
import { standard5July2016, getSupportedKeySystem } from './eme';
import {
  default as fairplay,
  LEGACY_FAIRPLAY_KEY_SYSTEM
} from './fairplay';
import {
  default as msPrefixed,
  PLAYREADY_KEY_SYSTEM
} from './ms-prefixed';
import {detectSupportedCDMs } from './cdm.js';
import { arrayBuffersEqual, arrayBufferFrom, merge, getMediaKeySystemConfigurations } from './utils';
import {version as VERSION} from '../package.json';
import EmeError from './consts/errors';

export const hasSession = (sessions, initData) => {
  for (let i = 0; i < sessions.length; i++) {
    // Other types of sessions may be in the sessions array that don't store the initData
    // (for instance, PlayReady sessions on IE11).
    if (!sessions[i].initData) {
      continue;
    }

    // initData should be an ArrayBuffer by the spec:
    // eslint-disable-next-line max-len
    // @see [Media Encrypted Event initData Spec]{@link https://www.w3.org/TR/encrypted-media/#mediaencryptedeventinit}
    //
    // However, on some browsers it may come back with a typed array view of the buffer.
    // This is the case for IE11, however, since IE11 sessions are handled differently
    // (following the msneedkey PlayReady path), this coversion may not be important. It
    // is safe though, and might be a good idea to retain in the short term (until we have
    // catalogued the full range of browsers and their implementations).
    const sessionBuffer = arrayBufferFrom(sessions[i].initData);
    const initDataBuffer = arrayBufferFrom(initData);

    if (arrayBuffersEqual(sessionBuffer, initDataBuffer)) {
      return true;
    }
  }

  return false;
};

export const removeSession = (sessions, initData) => {
  for (let i = 0; i < sessions.length; i++) {
    if (sessions[i].initData === initData) {
      sessions.splice(i, 1);
      return;
    }
  }
};

export function handleEncryptedEvent(player, event, options, sessions, eventBus, emeError) {
  if (!options || !options.keySystems) {
    // return silently since it may be handled by a different system
    return Promise.resolve();
  }
  // Legacy fairplay is the keysystem 'com.apple.fps.1_0'.
  // If we are using this keysystem we want to use WebkitMediaKeys.
  // This can be initialized manually with initLegacyFairplay().
  if (options.keySystems[LEGACY_FAIRPLAY_KEY_SYSTEM]) {
    videojs.log.debug('eme', `Ignoring \'encrypted\' event, using legacy fairplay keySystem ${LEGACY_FAIRPLAY_KEY_SYSTEM}`);
    return Promise.resolve();
  }

  let initData = event.initData;

  return getSupportedKeySystem(options.keySystems).then((keySystemAccess) => {
    const keySystem = keySystemAccess.keySystem;

    // Use existing init data from options if provided
    if (options.keySystems[keySystem] &&
        options.keySystems[keySystem].pssh) {
      initData = options.keySystems[keySystem].pssh;
    }

    // "Initialization Data must be a fixed value for a given set of stream(s) or media
    // data. It must only contain information related to the keys required to play a given
    // set of stream(s) or media data."
    // eslint-disable-next-line max-len
    // @see [Initialization Data Spec]{@link https://www.w3.org/TR/encrypted-media/#initialization-data}
    if (hasSession(sessions, initData) || !initData) {
      // TODO convert to videojs.log.debug and add back in
      // https://github.com/videojs/video.js/pull/4780
      // videojs.log('eme',
      //             'Already have a configured session for init data, ignoring event.');
      return Promise.resolve();
    }

    sessions.push({ initData });
    return standard5July2016({
      player,
      video: event.target,
      initDataType: event.initDataType,
      initData,
      keySystemAccess,
      options,
      removeSession: removeSession.bind(null, sessions),
      eventBus,
      emeError
    });
  }).catch((error) => {
    const metadata = {
      errorType: EmeError.EMEFailedToRequestMediaKeySystemAccess,
      config: getMediaKeySystemConfigurations(options.keySystems)
    };

    emeError(error, metadata);
  });
}

export const handleWebKitNeedKeyEvent = (event, options, eventBus, emeError) => {
  if (!options.keySystems || !options.keySystems[LEGACY_FAIRPLAY_KEY_SYSTEM] || !event.initData) {
    // return silently since it may be handled by a different system
    return Promise.resolve();
  }

  // From Apple's example Safari FairPlay integration code, webkitneedkey is not repeated
  // for the same content. Unless documentation is found to present the opposite, handle
  // all webkitneedkey events the same (even if they are repeated).

  return fairplay({
    video: event.target,
    initData: event.initData,
    options,
    eventBus,
    emeError
  });
};

export const handleMsNeedKeyEvent = (event, options, sessions, eventBus, emeError) => {
  if (!options.keySystems || !options.keySystems[PLAYREADY_KEY_SYSTEM]) {
    // return silently since it may be handled by a different system
    return;
  }

  // "With PlayReady content protection, your Web app must handle the first needKey event,
  // but it must then ignore any other needKey event that occurs."
  // eslint-disable-next-line max-len
  // @see [PlayReady License Acquisition]{@link https://msdn.microsoft.com/en-us/library/dn468979.aspx}
  //
  // Usually (and as per the example in the link above) this is determined by checking for
  // the existence of video.msKeys. However, since the video element may be reused, it's
  // easier to directly manage the session.
  if (sessions.reduce((acc, session) => acc || session.playready, false)) {
    // TODO convert to videojs.log.debug and add back in
    // https://github.com/videojs/video.js/pull/4780
    // videojs.log('eme',
    //             'An \'msneedkey\' event was receieved earlier, ignoring event.');
    return;
  }

  let initData = event.initData;

  // Use existing init data from options if provided
  if (options.keySystems[PLAYREADY_KEY_SYSTEM] &&
      options.keySystems[PLAYREADY_KEY_SYSTEM].pssh) {
    initData = options.keySystems[PLAYREADY_KEY_SYSTEM].pssh;
  }

  if (!initData) {
    return;
  }

  sessions.push({ playready: true, initData });

  msPrefixed({
    video: event.target,
    initData,
    options,
    eventBus,
    emeError
  });
};

export const getOptions = (player) => {
  return merge(player.currentSource(), player.eme.options);
};

/**
 * Configure a persistent sessions array and activeSrc property to ensure we properly
 * handle each independent source's events. Should be run on any encrypted or needkey
 * style event to ensure that the sessions reflect the active source.
 *
 * @function setupSessions
 * @param    {Player} player
 */
export const setupSessions = (player) => {
  const src = player.src();

  if (src !== player.eme.activeSrc) {
    player.eme.activeSrc = src;
    player.eme.sessions = [];
  }
};

/**
 * Construct a simple function that can be used to dispatch EME errors on the
 * player directly, such as providing it to a `.catch()`.
 *
 * @function emeErrorHandler
 * @param    {Player} player
 * @return   {Function}
 */
export const emeErrorHandler = (player) => {
  return (objOrErr, metadata) => {
    const error = {
      // MEDIA_ERR_ENCRYPTED is code 5
      code: 5
    };

    if (typeof objOrErr === 'string') {
      error.message = objOrErr;
    } else if (objOrErr) {
      if (objOrErr.message) {
        error.message = objOrErr.message;
      }
      if (objOrErr.cause &&
          (objOrErr.cause.length ||
           objOrErr.cause.byteLength)) {
        error.cause = objOrErr.cause;
      }
      if (objOrErr.keySystem) {
        error.keySystem = objOrErr.keySystem;
      }
      // pass along original error object.
      error.originalError = objOrErr;
    }

    if (metadata) {
      error.metadata = metadata;
    }

    player.error(error);
  };
};

/**
 * Function to invoke when the player is ready.
 *
 * This is a great place for your plugin to initialize itself. When this
 * function is called, the player will have its DOM and child components
 * in place.
 *
 * @function onPlayerReady
 * @param    {Player} player
 * @param    {Function} emeError
 */
const onPlayerReady = (player, emeError) => {
  if (player.$('.vjs-tech').tagName.toLowerCase() !== 'video') {
    return;
  }

  setupSessions(player);

  /*
   * If playback is switched to AirPlay, we will receive another encrypted event,
   * proxied from the AirPlay device, as is described here:
   *
   * https://developer.apple.com/streaming/fps/FairPlayStreamingOverview.pdf
   *
   * To accomodate for this, we should clear our list of sessions when the playback
   * target changes, because the request is otherwise dropped as a duplicate.
   */
  if ('webkitCurrentPlaybackTargetIsWireless' in player.tech_.el_) {
    player.tech_.el_.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      player.eme.sessions = [];
    });
  }

  if (window.MediaKeys) {
    const sendMockEncryptedEvent = () => {
      const mockEncryptedEvent = {
        initDataType: 'cenc',
        initData: null,
        target: player.tech_.el_
      };

      setupSessions(player);
      handleEncryptedEvent(player, mockEncryptedEvent, getOptions(player), player.eme.sessions, player.tech_, emeError);
    };

    if (videojs.browser.IS_FIREFOX) {
      // Unlike Chrome, Firefox doesn't receive an `encrypted` event on
      // replay and seek-back after content ends and `handleEncryptedEvent` is never called.
      // So a fake encrypted event is necessary here.

      let handled;

      player.on('ended', () =>{
        handled = false;
        player.one(['seek', 'play'], (e) => {
          if (!handled && player.eme.sessions.length === 0) {
            sendMockEncryptedEvent();
            handled = true;
          }
        });
      });
      player.on('play', () => {
        const options = player.eme.options;
        const limitRenewalsMaxPauseDuration = options.limitRenewalsMaxPauseDuration;

        if (player.eme.sessions.length === 0 && typeof limitRenewalsMaxPauseDuration === 'number') {
          handled = true;
          sendMockEncryptedEvent();
        }
      });
    }

    // Support EME 05 July 2016
    // Chrome 42+, Firefox 47+, Edge, Safari 12.1+ on macOS 10.14+
    player.tech_.el_.addEventListener('encrypted', (event) => {
      videojs.log.debug('eme', 'Received an \'encrypted\' event');
      setupSessions(player);
      handleEncryptedEvent(player, event, getOptions(player), player.eme.sessions, player.tech_, emeError);
    });
  } else if (window.WebKitMediaKeys) {
    player.eme.initLegacyFairplay();
  } else if (window.MSMediaKeys) {
    // IE11 Windows 8.1+
    // Since IE11 doesn't support promises, we have to use a combination of
    // try/catch blocks and event handling to simulate promise rejection.
    // Functionally speaking, there should be no discernible difference between
    // the behavior of IE11 and those of other browsers.
    player.tech_.el_.addEventListener('msneedkey', (event) => {
      videojs.log.debug('eme', 'Received an \'msneedkey\' event');
      setupSessions(player);
      try {
        handleMsNeedKeyEvent(event, getOptions(player), player.eme.sessions, player.tech_, emeError);
      } catch (error) {
        emeError(error);
      }
    });
    const msKeyErrorCallback = (error) => {
      emeError(error);
    };

    player.tech_.on('mskeyerror', msKeyErrorCallback);
    // TODO: refactor this plugin so it can use a plugin dispose
    player.on('dispose', () => {
      player.tech_.off('mskeyerror', msKeyErrorCallback);
    });
  }
};

/**
 * A video.js plugin.
 *
 * In the plugin function, the value of `this` is a video.js `Player`
 * instance. You cannot rely on the player being in a "ready" state here,
 * depending on how the plugin is invoked. This may or may not be important
 * to you; if not, remove the wait for "ready"!
 *
 * @function eme
 * @param    {Object} [options={}]
 *           An object of options left to the plugin author to define.
 */
const eme = function(options = {}) {
  const player = this;
  const emeError = emeErrorHandler(player);

  player.ready(() => onPlayerReady(player, emeError));

  // Plugin API
  player.eme = {
    /**
     * For manual setup for eme listeners (for example: after player.reset call)
     * basically for any cases when player.tech.el is changed
     */
    setupEmeListeners() {
      onPlayerReady(player, emeError);
    },
    /**
    * Sets up MediaKeys on demand
    * Works around https://bugs.chromium.org/p/chromium/issues/detail?id=895449
    *
    * @function initializeMediaKeys
    * @param    {Object} [emeOptions={}]
    *           An object of eme plugin options.
    * @param    {Function} [callback=function(){}]
    * @param    {boolean} [suppressErrorIfPossible=false]
    */
    initializeMediaKeys(emeOptions = {}, callback = function() {}, suppressErrorIfPossible = false) {
      // TODO: this should be refactored and renamed to be less tied
      // to encrypted events
      const mergedEmeOptions = merge(
        player.currentSource(),
        options,
        emeOptions
      );

      // fake an encrypted event for handleEncryptedEvent
      const mockEncryptedEvent = {
        initDataType: 'cenc',
        initData: null,
        target: player.tech_.el_
      };

      setupSessions(player);

      if (window.MediaKeys) {
        handleEncryptedEvent(player, mockEncryptedEvent, mergedEmeOptions, player.eme.sessions, player.tech_, emeError)
          .then(() => callback())
          .catch((error) => {
            callback(error);
            if (!suppressErrorIfPossible) {
              emeError(error);
            }
          });
      } else if (window.MSMediaKeys) {
        const msKeyHandler = (event) => {
          player.tech_.off('mskeyadded', msKeyHandler);
          player.tech_.off('mskeyerror', msKeyHandler);
          if (event.type === 'mskeyerror') {
            callback(event.target.error);
            if (!suppressErrorIfPossible) {
              emeError(event.message);
            }
          } else {
            callback();
          }
        };

        player.tech_.one('mskeyadded', msKeyHandler);
        player.tech_.one('mskeyerror', msKeyHandler);
        try {
          handleMsNeedKeyEvent(mockEncryptedEvent, mergedEmeOptions, player.eme.sessions, player.tech_, emeError);
        } catch (error) {
          player.tech_.off('mskeyadded', msKeyHandler);
          player.tech_.off('mskeyerror', msKeyHandler);
          callback(error);
          if (!suppressErrorIfPossible) {
            emeError(error);
          }
        }
      }
    },
    initLegacyFairplay() {
      const handleFn = (event) => {
        videojs.log.debug('eme', 'Received a \'webkitneedkey\' event');
        // TODO it's possible that the video state must be cleared if reusing the same video
        // element between sources
        setupSessions(player);
        handleWebKitNeedKeyEvent(event, getOptions(player), player.tech_, emeError)
          .catch((error) => {
            emeError(error);
          });
      };

      const webkitNeedKeyEventHandler = (event) => {
        const firstWebkitneedkeyTimeout = getOptions(player).firstWebkitneedkeyTimeout || 1000;
        const src = player.src();
        // on source change or first startup reset webkitneedkey options.

        player.eme.webkitneedkey_ = player.eme.webkitneedkey_ || {};

        // if the source changed we need to handle the first event again.
        // track source changes internally.
        if (player.eme.webkitneedkey_.src !== src) {
          player.eme.webkitneedkey_ = {
            handledFirstEvent: false,
            src
          };
        }
        // It's possible that at the start of playback a rendition switch
        // on a small player in safari's HLS implementation will cause
        // two webkitneedkey events to occur. We want to make sure to cancel
        // our first existing request if we get another within 1 second. This
        // prevents a non-fatal player error from showing up due to a
        // request failure.
        if (!player.eme.webkitneedkey_.handledFirstEvent) {
          // clear the old timeout so that a new one can be created
          // with the new rendition's event data
          player.clearTimeout(player.eme.webkitneedkey_.timeout);
          player.eme.webkitneedkey_.timeout = player.setTimeout(() => {
            player.eme.webkitneedkey_.handledFirstEvent = true;
            player.eme.webkitneedkey_.timeout = null;
            handleFn(event);
          }, firstWebkitneedkeyTimeout);
          // after we have a verified first request, we will request on
          // every other event like normal.
        } else {
          handleFn(event);
        }
      };

      let videoElement = player.tech_.el_;

      // Support Safari EME with FairPlay
      // (also used in early Chrome or Chrome with EME disabled flag)
      videoElement.addEventListener('webkitneedkey', webkitNeedKeyEventHandler);

      const cleanupWebkitNeedKeyHandler = () => {
        // no need in auto-cleanup if manual clean is called
        player.off('dispose', cleanupWebkitNeedKeyHandler);
        // check for null, if manual cleanup is called multiple times for any reason
        if (videoElement !== null) {
          videoElement.removeEventListener('webkitneedkey', webkitNeedKeyEventHandler);
        }

        videoElement = null;
      };

      // auto-cleanup:
      player.on('dispose', cleanupWebkitNeedKeyHandler);

      // returning for manual cleanup
      return cleanupWebkitNeedKeyHandler;
    },
    detectSupportedCDMs,
    options
  };
};

// Register the plugin with video.js.
videojs.registerPlugin('eme', eme);

// contrib-eme specific error const
eme.Error = EmeError;

// Include the version number.
eme.VERSION = VERSION;

export default eme;
