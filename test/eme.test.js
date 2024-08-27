import document from 'global/document';

import QUnit from 'qunit';
import videojs from 'video.js';
import window from 'global/window';
import {
  defaultGetLicense,
  standard5July2016,
  makeNewRequest,
  getSupportedKeySystem,
  addSession,
  addPendingSessions,
  getSupportedConfigurations
} from '../src/eme';
import { getMockEventBus } from './utils';
import sinon from 'sinon';

// mock session to make testing easier (so we can trigger events)
const getMockSession = () => {
  const mockSession = {
    addEventListener: (type, listener) => mockSession.listeners.push({ type, listener }),
    generateRequest(initDataType, initData) {
      // noop
      return new Promise((resolve, reject) => resolve());
    },
    keyStatuses: new Map(),
    close: () => {
      mockSession.numCloses++;
      // fake a promise for easy testing
      return {
        then: (nextCall) => {
          nextCall();
          return Promise.resolve();
        }
      };
    },
    numCloses: 0,
    listeners: []
  };

  return mockSession;
};

const resolveReject = (rejectVariable, rejectMessage) => {
  return new Promise((resolve, reject) => {
    if (rejectVariable) {
      reject(rejectMessage);
      return;
    }
    resolve();
  });
};

QUnit.module('videojs-contrib-eme eme', {
  beforeEach() {
    this.fixture = document.getElementById('qunit-fixture');
    this.video = document.createElement('video');
    this.fixture.appendChild(this.video);
    this.player = videojs(this.video);
    this.origXhr = videojs.xhr;
  },
  afterEach() {
    videojs.xhr = this.origXhr;
  }
});

QUnit.test('keystatuseschange triggers keystatuschange on eventBus for each key', function(assert) {
  const callCount = {total: 0, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}};
  const initData = new Uint8Array([1, 2, 3]);
  const mockSession = getMockSession();
  const eventBus = {
    trigger: (event) => {
      if (typeof event === 'string' || event.type !== 'keystatuschange') {
        return;
      }

      if (!callCount[event.keyId][event.status]) {
        callCount[event.keyId][event.status] = 0;
      }
      callCount[event.keyId][event.status]++;
      callCount.total++;
    },
    isDisposed: () => {
      return false;
    }
  };

  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => mockSession
    },
    initDataType: '',
    initData,
    options: {},
    getLicense() {},
    removeSession() {},
    eventBus,
    emeError() {}
  });

  assert.equal(mockSession.listeners.length, 2, 'added listeners');
  assert.equal(
    mockSession.listeners[1].type,
    'keystatuseschange',
    'added keystatuseschange listener'
  );

  // no key statuses
  mockSession.listeners[1].listener();

  assert.equal(callCount.total, 0, 'no events dispatched yet');

  mockSession.keyStatuses.set(1, 'unrecognized');
  mockSession.keyStatuses.set(2, 'expired');
  mockSession.keyStatuses.set(3, 'internal-error');
  mockSession.keyStatuses.set(4, 'output-restricted');
  mockSession.keyStatuses.set(5, 'output-restricted');

  mockSession.listeners[1].listener();
  assert.equal(
    callCount[1].unrecognized, 1,
    'dispatched `unrecognized` key status for key 1'
  );
  assert.equal(
    callCount[2].expired, 1,
    'dispatched `expired` key status for key 2'
  );
  assert.equal(
    callCount[3]['internal-error'], 1,
    'dispatched `internal-error` key status for key 3'
  );
  assert.equal(
    callCount[4]['output-restricted'], 1,
    'dispatched `output-restricted` key status for key 4'
  );
  assert.equal(
    callCount[5]['output-restricted'], 1,
    'dispatched `output-restricted` key status for key 5'
  );
  assert.equal(callCount.total, 5, '5 keystatuschange events received so far');

  // Change a single key and check that it's triggered for all keys
  mockSession.keyStatuses.set(1, 'usable');

  mockSession.listeners[1].listener();
  assert.equal(
    callCount[1].usable, 1,
    'dispatched `usable` key status for key 1'
  );
  assert.equal(
    callCount[2].expired, 2,
    'dispatched `expired` key status for key 2'
  );
  assert.equal(
    callCount[3]['internal-error'], 2,
    'dispatched `internal-error` key status for key 3'
  );
  assert.equal(
    callCount[4]['output-restricted'], 2,
    'dispatched `output-restricted` key status for key 4'
  );
  assert.equal(
    callCount[5]['output-restricted'], 2,
    'dispatched `output-restricted` key status for key 5'
  );
  assert.equal(callCount.total, 10, '10 keystatuschange events received so far');

  // Change the key statuses and recheck
  mockSession.keyStatuses.set(1, 'output-downscaled');
  mockSession.keyStatuses.set(2, 'released');
  mockSession.keyStatuses.set(3, 'usable');
  mockSession.keyStatuses.set(4, 'status-pending');
  mockSession.keyStatuses.set(5, 'usable');

  mockSession.listeners[1].listener();
  assert.equal(
    callCount[1]['output-downscaled'], 1,
    'dispatched `output-downscaled` key status for key 1'
  );
  assert.equal(
    callCount[2].released, 1,
    'dispatched `released` key status for key 2'
  );
  assert.equal(
    callCount[3].usable, 1,
    'dispatched `usable` key status for key 3'
  );
  assert.equal(
    callCount[4]['status-pending'], 1,
    'dispatched `status-pending` key status for key 4'
  );
  assert.equal(
    callCount[5].usable, 1,
    'dispatched `usable` key status for key 5'
  );
  assert.equal(callCount.total, 15, '15 keystatuschange events received so far');

});

QUnit.test('keystatuseschange with expired key closes', function(assert) {
  const removeSessionCalls = [];
  // once the eme module gets the removeSession function, the session argument is already
  // bound to the function (note that it's a custom session maintained by the plugin, not
  // the native session), so only initData is passed
  const removeSession = (initData) => removeSessionCalls.push(initData);
  const initData = new Uint8Array([1, 2, 3]);
  const mockSession = getMockSession();
  const eventBus = {
    trigger: (name) => {},
    isDisposed: () => {
      return false;
    }
  };
  let creates = 0;

  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => {
        creates++;

        return mockSession;
      }
    },
    initDataType: '',
    initData,
    options: {},
    getLicense() {},
    removeSession,
    eventBus
  });

  assert.equal(creates, 1, 'created session');
  assert.equal(mockSession.listeners.length, 2, 'added listeners');
  assert.equal(
    mockSession.listeners[1].type,
    'keystatuseschange',
    'added keystatuseschange listener'
  );
  assert.equal(mockSession.numCloses, 0, 'no session close calls');
  assert.equal(removeSessionCalls.length, 0, 'no removeSession calls');

  // no key statuses
  mockSession.listeners[1].listener();

  assert.equal(mockSession.numCloses, 0, 'no session close calls');
  assert.equal(removeSessionCalls.length, 0, 'no removeSession calls');

  mockSession.keyStatuses.set(1, 'unrecognized');
  mockSession.listeners[1].listener();

  assert.equal(mockSession.numCloses, 0, 'no session close calls');
  assert.equal(removeSessionCalls.length, 0, 'no removeSession calls');

  mockSession.keyStatuses.set(2, 'expired');
  mockSession.listeners[1].listener();

  assert.equal(mockSession.numCloses, 1, 'closed session');
  // close promise is fake and resolves synchronously, so we can assert removes
  // synchronously
  assert.equal(removeSessionCalls.length, 1, 'called remove session');
  assert.equal(removeSessionCalls[0], initData, 'called to remove session with initData');

  assert.equal(creates, 1, 'no new session created');
});

QUnit.test('sessions are closed and removed on `ended` after expiry', function(assert) {
  const done = assert.async();
  let getLicenseCalls = 0;
  const options = {
    keySystems: {
      'com.widevine.alpha': {
        url: 'some-url',
        getLicense(emeOptions, keyMessage, callback) {
          getLicenseCalls++;
        }
      }
    }
  };
  const removeSessionCalls = [];
  // once the eme module gets the removeSession function, the session argument is already
  // bound to the function (note that it's a custom session maintained by the plugin, not
  // the native session), so only initData is passed
  const removeSession = (initData) => removeSessionCalls.push(initData);

  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.resolve({
        setServerCertificate: () => Promise.resolve(),
        createSession: () => {
          return {
            addEventListener: (event, callback) => {
              if (event === 'message') {
                setTimeout(() => {
                  callback({message: 'whatever', messageType: 'license-renewal'});
                  assert.equal(getLicenseCalls, 0, 'did not call getLicense');
                  assert.equal(removeSessionCalls.length, 1, 'session is removed');
                  done();
                });
              }
            },
            keyStatuses: [],
            generateRequest: () => Promise.resolve(),
            close: () => {
              return {
                then: (nextCall) => {
                  nextCall();
                  return Promise.resolve();
                }
              };
            }
          };
        }
      });
    }
  };
  const video = {
    setMediaKeys: () => Promise.resolve()
  };

  this.player.ended = () => true;
  standard5July2016({
    player: this.player,
    video,
    keySystemAccess,
    options,
    eventBus: getMockEventBus(),
    removeSession
  });
});

QUnit.test('keystatuseschange with internal-error logs a warning', function(assert) {
  const origWarn = videojs.log.warn;
  const initData = new Uint8Array([1, 2, 3]);
  const mockSession = getMockSession();
  const warnCalls = [];
  const eventBus = {
    trigger: (name) => {},
    isDisposed: () => {
      return false;
    }
  };

  videojs.log.warn = (...args) => warnCalls.push(args);

  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => mockSession
    },
    initDataType: '',
    initData,
    options: {},
    getLicense() {},
    removeSession() {},
    eventBus
  });

  assert.equal(mockSession.listeners.length, 2, 'added listeners');
  assert.equal(
    mockSession.listeners[1].type,
    'keystatuseschange',
    'added keystatuseschange listener'
  );

  // no key statuses
  mockSession.listeners[1].listener();

  assert.equal(warnCalls.length, 0, 'no warn logs');

  mockSession.keyStatuses.set(1, 'internal-error');

  const keyStatusChangeEvent = {};

  mockSession.listeners[1].listener(keyStatusChangeEvent);

  assert.equal(warnCalls.length, 1, 'one warn log');
  assert.equal(
    warnCalls[0][0],
    'Key status reported as "internal-error." Leaving the session open ' +
               'since we don\'t have enough details to know if this error is fatal.',
    'logged correct warning'
  );
  assert.equal(warnCalls[0][1], keyStatusChangeEvent, 'logged event object');

  videojs.log.warn = origWarn;
});

QUnit.test('accepts a license URL as an option', function(assert) {
  const done = assert.async();
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  const mockSession = getMockSession();
  const mockEventBus = getMockEventBus();
  const mockMessageEvent = {
    type: 'message',
    message: 'the-message',
    messageType: 'license-request'
  };

  videojs.xhr = (options) => {
    xhrCalls.push(options);
  };

  const createSession = () => mockSession;
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return {
        createSession
      };
    }
  };

  standard5July2016({
    player: this.player,
    keySystemAccess,
    video: {
      setMediaKeys: (createdMediaKeys) => Promise.resolve(createdMediaKeys)
    },
    initDataType: '',
    initData: '',
    options: {
      keySystems: {
        'com.widevine.alpha': 'some-url'
      }
    },
    eventBus: mockEventBus
  }).catch((e) => {});

  setTimeout(() => {
    assert.equal(mockSession.listeners.length, 2, 'added listeners');
    assert.equal(
      mockSession.listeners[0].type,
      'message',
      'added message listener'
    );

    // Simulate 'message' event
    mockSession.listeners[0].listener(mockMessageEvent);

    assert.equal(mockEventBus.calls[0].type, 'keysystemaccesscomplete', 'keysystemaccesscomplete fired');
    assert.deepEqual(mockEventBus.calls[0].mediaKeys, { createSession }, 'keysystemaccesscomplete payload fired');
    assert.equal(mockEventBus.calls[1].type, 'keysessioncreated', 'keysessioncreated fired');
    assert.equal(mockEventBus.calls[1].keySession, mockSession, 'keysessioncreated payload fired');
    assert.equal(mockEventBus.calls[2].type, 'keymessage', 'keymessage event type is expected type');
    assert.equal(mockEventBus.calls[2].messageEvent, mockMessageEvent, 'keymessage event is expected message event');
    assert.equal(xhrCalls.length, 1, 'made one XHR');
    assert.deepEqual(xhrCalls[0], {
      uri: 'some-url',
      method: 'POST',
      responseType: 'arraybuffer',
      requestType: 'license',
      metadata: { keySystem: 'com.widevine.alpha' },
      body: 'the-message',
      headers: {
        'content-type': 'application/octet-stream'
      }
    }, 'made request with proper options');

    videojs.xhr = origXhr;

    done();
  });
});

QUnit.test('accepts a license URL as property', function(assert) {
  const done = assert.async();
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  const mockSession = getMockSession();
  const mockEventBus = getMockEventBus();
  const createSession = () => mockSession;
  const mockMessageEvent = {
    type: 'message',
    message: 'the-message',
    messageType: 'license-request'
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return {
        createSession
      };
    }
  };

  videojs.xhr = (options) => {
    xhrCalls.push(options);
  };

  standard5July2016({
    player: this.player,
    keySystemAccess,
    video: {
      setMediaKeys: (createdMediaKeys) => Promise.resolve(createdMediaKeys)
    },
    initDataType: '',
    initData: '',
    options: {
      keySystems: {
        'com.widevine.alpha': {
          url: 'some-url'
        }
      }
    },
    eventBus: mockEventBus
  }).catch((e) => {});

  setTimeout(() => {
    assert.equal(mockSession.listeners.length, 2, 'added listeners');
    assert.equal(
      mockSession.listeners[0].type,
      'message',
      'added message listener'
    );

    // Simulate 'message' event
    mockSession.listeners[0].listener(mockMessageEvent);

    assert.equal(mockEventBus.calls[0].type, 'keysystemaccesscomplete', 'keysystemaccesscomplete fired');
    assert.deepEqual(mockEventBus.calls[0].mediaKeys, { createSession }, 'keysystemaccesscomplete payload');
    assert.equal(mockEventBus.calls[1].type, 'keysessioncreated', 'keymessage fired');
    assert.equal(mockEventBus.calls[2].messageEvent, mockMessageEvent, 'keymessage event is expected message event');
    assert.equal(xhrCalls.length, 1, 'made one XHR');
    assert.deepEqual(xhrCalls[0], {
      uri: 'some-url',
      method: 'POST',
      responseType: 'arraybuffer',
      requestType: 'license',
      metadata: { keySystem: 'com.widevine.alpha' },
      body: 'the-message',
      headers: {
        'content-type': 'application/octet-stream'
      }
    }, 'made request with proper options');

    videojs.xhr = origXhr;

    done();
  });
});

QUnit.test('5 July 2016 lifecycle', function(assert) {
  assert.expect(34);

  let errors = 0;
  const done = assert.async();
  const callbacks = {};
  const callCounts = {
    getCertificate: 0,
    getLicense: 0,
    createSession: 0,
    keySessionGenerateRequest: 0,
    keySessionUpdate: 0,
    createMediaKeys: 0,
    licenseRequestAttempts: 0,
    keysessionUpdatedEvent: 0
  };

  const getCertificate = (emeOptions, callback) => {
    callCounts.getCertificate++;
    callbacks.getCertificate = callback;
  };
  const getLicense = (emeOptions, keyMessage, callback) => {
    callCounts.getLicense++;
    callbacks.getLicense = callback;
  };

  let setMediaKeys;
  const video = {
    setMediaKeys: (mediaKeys) => {
      setMediaKeys = mediaKeys;
      return Promise.resolve(mediaKeys);
    }
  };

  const options = {
    keySystems: {
      'org.w3.clearkey': {
        getCertificate,
        getLicense
      }
    }
  };

  const eventBus = {
    trigger: (event) => {
      const name = typeof event === 'string' ? event : event.type;

      if (name === 'licenserequestattempted') {
        callCounts.licenseRequestAttempts++;
      }
      if (name === 'keysessionupdated') {
        callCounts.keysessionUpdatedEvent++;
      }
    },
    isDisposed: () => {
      return false;
    }
  };

  const keySessionEventListeners = {};
  const mediaKeys = {
    createSession: () => {
      callCounts.createSession++;
      return {
        addEventListener: (name, callback) => {
          keySessionEventListeners[name] = callback;
        },
        generateRequest: () => {
          callCounts.keySessionGenerateRequest++;
          return new Promise(() => {});
        },
        update: () => {
          callCounts.keySessionUpdate++;
          return Promise.resolve();
        },
        close: () => {}
      };
    }
  };

  const keySystemAccess = {
    keySystem: 'org.w3.clearkey',
    createMediaKeys: () => {
      callCounts.createMediaKeys++;
      return mediaKeys;
    }
  };

  standard5July2016({
    player: this.player,
    video,
    initDataType: '',
    initData: '',
    keySystemAccess,
    options,
    eventBus
  }).then(() => done()).catch(() => errors++);

  // Step 1: get certificate
  assert.equal(callCounts.getCertificate, 1, 'certificate requested');
  assert.equal(callCounts.createMediaKeys, 0, 'media keys not created');
  assert.notEqual(mediaKeys, setMediaKeys, 'media keys not yet set');
  assert.equal(callCounts.createSession, 0, 'key session not created');
  assert.equal(callCounts.keySessionGenerateRequest, 0, 'key session request not made');
  assert.equal(callCounts.getLicense, 0, 'license not requested');
  assert.equal(callCounts.keySessionUpdate, 0, 'key session not updated');
  assert.equal(
    callCounts.licenseRequestAttempts, 0,
    'license request event not triggered (since no callback yet)'
  );

  callbacks.getCertificate(null, '');

  // getCertificate promise resolution
  setTimeout(() => {
    // Step 2: create media keys, set them, and generate key session request
    assert.equal(callCounts.getCertificate, 1, 'certificate requested');
    assert.equal(callCounts.createMediaKeys, 1, 'media keys created');
    assert.equal(mediaKeys, setMediaKeys, 'media keys set');
    assert.equal(callCounts.createSession, 1, 'key session created');
    assert.equal(callCounts.keySessionGenerateRequest, 1, 'key session request made');
    assert.equal(callCounts.getLicense, 0, 'license not requested');
    assert.equal(callCounts.keySessionUpdate, 0, 'key session not updated');
    assert.equal(
      callCounts.licenseRequestAttempts, 0,
      'license request event not triggered (since no callback yet)'
    );

    keySessionEventListeners.message({messageType: 'license-request'});

    // Step 3: get license
    assert.equal(callCounts.getCertificate, 1, 'certificate requested');
    assert.equal(callCounts.createMediaKeys, 1, 'media keys created');
    assert.equal(mediaKeys, setMediaKeys, 'media keys set');
    assert.equal(callCounts.createSession, 1, 'key session created');
    assert.equal(callCounts.keySessionGenerateRequest, 1, 'key session request made');
    assert.equal(callCounts.getLicense, 1, 'license requested');
    assert.equal(callCounts.keySessionUpdate, 0, 'key session not updated');
    assert.equal(
      callCounts.licenseRequestAttempts, 0,
      'license request event not triggered (since no callback yet)'
    );

    callbacks.getLicense();

    // getLicense promise resolution
    setTimeout(() => {
      // Step 4: update key session
      assert.equal(callCounts.getCertificate, 1, 'certificate requested');
      assert.equal(callCounts.createMediaKeys, 1, 'media keys created');
      assert.equal(mediaKeys, setMediaKeys, 'media keys set');
      assert.equal(callCounts.createSession, 1, 'key session created');
      assert.equal(callCounts.keySessionGenerateRequest, 1, 'key session request made');
      assert.equal(callCounts.getLicense, 1, 'license requested');
      assert.equal(callCounts.keySessionUpdate, 1, 'key session updated');
      assert.equal(
        callCounts.licenseRequestAttempts, 1,
        'license request event triggered'
      );
      assert.equal(callCounts.keysessionUpdatedEvent, 1, 'keysessionupdated event fired once');
      assert.equal(errors, 0, 'no errors occurred');
    });
  });
});

// Skip this test in Safari, getSupportedKeySystem is never used in Safari.
if (!videojs.browser.IS_ANY_SAFARI) {
  QUnit.test('getSupportedKeySystem error', function(assert) {
    const done = assert.async(1);

    getSupportedKeySystem({'un.supported.keysystem': {}}).catch((err) => {
      assert.equal(err.name, 'NotSupportedError', 'keysystem access request fails');
      done();
    });
  });
}

QUnit.test('errors when missing url/licenseUri or getLicense', function(assert) {
  const options = {
    keySystems: {
      'com.widevine.alpha': {}
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha'
  };
  const done = assert.async(1);

  standard5July2016({
    player: this.player,
    video: {},
    keySystemAccess,
    options,
    eventBus: getMockEventBus()
  }).catch((err) => {
    assert.equal(
      err,
      'Error: Missing url/licenseUri or getLicense in com.widevine.alpha keySystem configuration.',
      'correct error message'
    );
    done();
  });
});

QUnit.test('errors when missing certificateUri and getCertificate for fairplay', function(assert) {
  const options = {
    keySystems: {
      'com.apple.fps': {url: 'fake-url'}
    }
  };
  const keySystemAccess = {
    keySystem: 'com.apple.fps'
  };
  const done = assert.async();

  standard5July2016({
    player: this.player,
    video: {},
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(
      err,
      'Error: Missing getCertificate or certificateUri in com.apple.fps keySystem configuration.',
      'correct error message'
    );
    done();
  });
});

QUnit.test('rejects promise when getCertificate throws error', function(assert) {
  const getCertificate = (options, callback) => {
    callback('error fetching certificate');
  };
  const options = {
    keySystems: {
      'com.widevine.alpha': {
        url: 'some-url',
        getCertificate
      }
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha'
  };
  const done = assert.async(1);
  const expectedError = 'error fetching certificate';
  const emeError = (error, metadata) => {
    assert.equal(error, expectedError, 'emeError called with expected message');
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeys, 'emeError called with expected type');
    assert.equal(metadata.keySystem, 'com.widevine.alpha', 'emeError called with expected type');
  };

  standard5July2016({
    player: this.player,
    video: {},
    keySystemAccess,
    options,
    eventBus: getMockEventBus(),
    emeError
  }).catch((err) => {
    assert.equal(err, expectedError, 'correct error message');
    done();
  });
});

QUnit.test('rejects promise when createMediaKeys rejects', function(assert) {
  const options = {
    keySystems: {
      'com.widevine.alpha': 'some-url'
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.reject();
    }
  };
  const done = assert.async(1);
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeys, 'emeError called with expected errorType');
    assert.equal(metadata.keySystem, 'com.widevine.alpha', 'emeError called with expected keySystem');
  };

  standard5July2016({
    player: this.player,
    video: {},
    keySystemAccess,
    options,
    eventBus: getMockEventBus(),
    emeError
  }).catch((err) => {
    assert.equal(
      err, 'Failed to create and initialize a MediaKeys object',
      'uses generic message'
    );
    done();
  });

});

QUnit.test('rejects promise when createMediaKeys rejects', function(assert) {
  const options = {
    keySystems: {
      'com.widevine.alpha': 'some-url'
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.reject('failed creating mediaKeys');
    }
  };
  const done = assert.async(1);
  const expectedError = 'failed creating mediaKeys';
  const emeError = (error, metadata) => {
    assert.equal(error, expectedError, 'emeError called with expected error');
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeys, 'emeError called with expected errorType');
    assert.equal(metadata.keySystem, 'com.widevine.alpha', 'emeError called with expected keySystem');
  };

  standard5July2016({
    player: this.player,
    video: {},
    keySystemAccess,
    options,
    eventBus: getMockEventBus(),
    emeError
  }).catch((err) => {
    assert.equal(err, expectedError, 'uses specific error when given');
    done();
  });

});

QUnit.test('rejects promise when addPendingSessions rejects', function(assert) {
  let rejectSetServerCertificate = true;
  const rejectGenerateRequest = true;
  let rejectSetMediaKeys = true;
  const options = {
    keySystems: {
      'com.widevine.alpha': {
        url: 'some-url',
        getCertificate: (emeOptions, callback) => {
          callback(null, 'some certificate');
        }
      }
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.resolve({
        setServerCertificate: () => resolveReject(
          rejectSetServerCertificate,
          'setServerCertificate failed'
        ),
        createSession: () => {
          return {
            addEventListener: () => {},
            generateRequest: () => resolveReject(
              rejectGenerateRequest,
              'generateRequest failed'
            ),
            close: () => {}
          };
        }
      });
    }
  };
  const video = {
    setMediaKeys: () => resolveReject(rejectSetMediaKeys, 'setMediaKeys failed')
  };
  const done = assert.async(3);
  const callbacks = [];
  const expectedErrors = [
    {
      error: 'setServerCertificate failed',
      errorType: videojs.Error.EMEFailedToSetServerCertificate
    },
    {
      error: 'setMediaKeys failed',
      errorType: videojs.Error.EMEFailedToAttachMediaKeysToVideoElement
    },
    {
      error: 'generateRequest failed',
      errorType: videojs.Error.EMEFailedToGenerateLicenseRequest
    }
  ];
  const test = (errMessage, testDescription) => {
    let expectedErrorsLength = 0;
    const emeErrors = [];

    video.mediaKeysObject = undefined;
    standard5July2016({
      player: this.player,
      video,
      keySystemAccess,
      options,
      eventBus: getMockEventBus(),
      emeError: (error, metadata) => {
        expectedErrorsLength++;
        emeErrors.push({error, errorType: metadata.errorType });
      }
    }).catch((err) => {
      assert.equal(err, errMessage, testDescription);
      assert.equal(emeErrors.length, expectedErrorsLength, 'emeError called expected number of times');
      for (let i = 0; i < expectedErrors.length; i++) {
        assert.equal(emeErrors[i].error, expectedErrors[i].error, 'expected eme error');
        assert.equal(emeErrors[i].errorType, expectedErrors[i].errorType, 'expected eme errorType');
      }
      expectedErrors.shift();
      done();
      if (callbacks[0]) {
        callbacks.shift()();
      }
    });
  };

  callbacks.push(() => {
    rejectSetServerCertificate = false;
    test('Unable to create or initialize key session', 'second promise fails');
  });
  callbacks.push(() => {
    rejectSetMediaKeys = false;
    test('Unable to create or initialize key session', 'third promise fails');
  });

  test('Unable to create or initialize key session', 'first promise fails');
});

QUnit.test('getLicense not called for messageType that isnt license-request or license-renewal', function(assert) {
  const done = assert.async();
  let getLicenseCalls = 0;
  const options = {
    keySystems: {
      'com.widevine.alpha': {
        url: 'some-url',
        getLicense(emeOptions, keyMessage, callback) {
          getLicenseCalls++;
        }
      }
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.resolve({
        setServerCertificate: () => Promise.resolve(),
        createSession: () => {
          return {
            addEventListener: (event, callback) => {
              if (event === 'message') {
                setTimeout(() => {
                  callback({message: 'whatever', messageType: 'do-not-request-license'});
                  assert.equal(getLicenseCalls, 0, 'did not call getLicense');
                  done();
                });
              }
            },
            keyStatuses: [],
            generateRequest: () => Promise.resolve(),
            close: () => {}
          };
        }
      });
    }
  };
  const video = {
    setMediaKeys: () => Promise.resolve()
  };

  standard5July2016({
    player: this.player,
    video,
    keySystemAccess,
    options,
    eventBus: getMockEventBus()
  });
});

QUnit.test('getLicense promise rejection', function(assert) {
  const options = {
    keySystems: {
      'com.widevine.alpha': {
        url: 'some-url',
        getLicense(emeOptions, keyMessage, callback) {
          callback('error getting license');
        }
      }
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.resolve({
        setServerCertificate: () => Promise.resolve(),
        createSession: () => {
          return {
            addEventListener: (event, callback) => {
              setTimeout(() => {
                callback({message: 'whatever', messageType: 'license-request'});
              });
            },
            keyStatuses: [],
            generateRequest: () => Promise.resolve(),
            close: () => {}
          };
        }
      });
    }
  };
  const video = {
    setMediaKeys: () => Promise.resolve()
  };
  const done = assert.async(1);

  standard5July2016({
    player: this.player,
    video,
    keySystemAccess,
    options,
    eventBus: getMockEventBus()
  }).catch((err) => {
    assert.equal(err, 'error getting license', 'correct error message');
    done();
  });

});

QUnit.test('getLicense calls back with error for 400 and 500 status codes', function(assert) {
  const getLicenseCallback = sinon.spy();
  const getLicense = defaultGetLicense('', {});

  function toArrayBuffer(obj) {
    const json = JSON.stringify(obj);
    const buffer = new ArrayBuffer(json.length);
    const bufferView = new Uint8Array(buffer);

    for (let i = 0; i < json.length; i++) {
      bufferView[i] = json.charCodeAt(i);
    }
    return buffer;
  }

  videojs.xhr = (params, callback) => {
    return callback(null, {statusCode: 400}, toArrayBuffer({body: 'some-body'}));
  };

  getLicense({}, null, getLicenseCallback);

  videojs.xhr = (params, callback) => {
    return callback(null, {statusCode: 500}, toArrayBuffer({body: 'some-body'}));
  };

  getLicense({}, null, getLicenseCallback);

  videojs.xhr = (params, callback) => {
    return callback(null, {statusCode: 599}, toArrayBuffer({body: 'some-body'}));
  };

  getLicense({}, null, getLicenseCallback);

  assert.equal(getLicenseCallback.callCount, 3, 'correct callcount');
  assert.ok(getLicenseCallback.alwaysCalledWith({
    cause: JSON.stringify({body: 'some-body'})
  }), 'getLicense callback called with correct error');
});

QUnit.test('getLicense calls back with response body for non-400/500 status codes', function(assert) {
  const getLicenseCallback = sinon.spy();
  const getLicense = defaultGetLicense('', {});

  videojs.xhr = (params, callback) => {
    return callback(null, {statusCode: 200}, {body: 'some-body'});
  };

  getLicense({}, null, getLicenseCallback);

  videojs.xhr = (params, callback) => {
    return callback(null, {statusCode: 399}, {body: 'some-body'});
  };

  getLicense({}, null, getLicenseCallback);

  videojs.xhr = (params, callback) => {
    return callback(null, {statusCode: 600}, {body: 'some-body'});
  };

  getLicense({}, null, getLicenseCallback);

  assert.equal(getLicenseCallback.callCount, 3, 'correct callcount');
  assert.equal(getLicenseCallback.alwaysCalledWith(null, {body: 'some-body'}), true, 'getLicense callback called with correct args');
});

QUnit.test('keySession.update promise rejection', function(assert) {
  const options = {
    keySystems: {
      'com.widevine.alpha': {
        url: 'some-url',
        getLicense(emeOptions, keyMessage, callback) {
          callback(null, 'license');
        }
      }
    }
  };
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return Promise.resolve({
        setServerCertificate: () => Promise.resolve(),
        createSession: () => {
          return {
            addEventListener: (event, callback) => {
              setTimeout(() => {
                callback({messageType: 'license-request', message: 'whatever'});
              });
            },
            keyStatuses: [],
            generateRequest: () => Promise.resolve(),
            update: () => Promise.reject('keySession update failed'),
            close: () => {}
          };
        }
      });
    }
  };
  const video = {
    setMediaKeys: () => Promise.resolve()
  };
  const done = assert.async(1);
  const emeError = (error, metadata) => {
    assert.equal(error, 'keySession update failed', 'correct error message');
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToUpdateSessionWithReceivedLicenseKeys, 'errorType is correct');
    assert.equal(metadata.keySystem, 'com.widevine.alpha', 'keySystem is correct');
    done();
  };

  standard5July2016({
    player: this.player,
    video,
    keySystemAccess,
    options,
    eventBus: getMockEventBus(),
    emeError
  });

});

QUnit.test('emeHeaders option sets headers on default license xhr request', function(assert) {
  const done = assert.async();
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  const mockSession = getMockSession();
  const mockEventBus = getMockEventBus();
  const mockMessageEvent = {
    type: 'message',
    message: 'the-message',
    messageType: 'license-request'
  };
  const createSession = () => mockSession;

  videojs.xhr = (options) => {
    xhrCalls.push(options);
  };

  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return {
        createSession
      };
    }
  };

  standard5July2016({
    player: this.player,
    keySystemAccess,
    video: {
      setMediaKeys: (createdMediaKeys) => Promise.resolve(createdMediaKeys)
    },
    initDataType: '',
    initData: '',
    options: {
      keySystems: {
        'com.widevine.alpha': 'some-url'
      },
      emeHeaders: {
        'some-header': 'some-header-value'
      }
    },
    eventBus: mockEventBus
  }).catch((e) => {});

  setTimeout(() => {
    // Simulate 'message' event
    mockSession.listeners[0].listener(mockMessageEvent);

    assert.equal(mockEventBus.calls[0].type, 'keysystemaccesscomplete', 'keysystemaccesscomplete fired');
    assert.deepEqual(mockEventBus.calls[0].mediaKeys, { createSession }, 'keysystemaccesscomplete payload');
    assert.equal(mockEventBus.calls[1].type, 'keysessioncreated', 'keymessage fired');
    assert.equal(mockEventBus.calls[2].messageEvent, mockMessageEvent, 'keymessage event is expected message event');
    assert.equal(xhrCalls.length, 1, 'made one XHR');
    assert.deepEqual(xhrCalls[0], {
      uri: 'some-url',
      method: 'POST',
      responseType: 'arraybuffer',
      requestType: 'license',
      metadata: { keySystem: 'com.widevine.alpha' },
      body: 'the-message',
      headers: {
        'content-type': 'application/octet-stream',
        'some-header': 'some-header-value'
      }
    }, 'made request with proper emeHeaders option value');

    videojs.xhr = origXhr;

    done();
  });
});

QUnit.test('licenseHeaders keySystems property overrides emeHeaders value', function(assert) {
  const done = assert.async();
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  const mockSession = getMockSession();
  const mockEventBus = getMockEventBus();
  const mockMessageEvent = {
    type: 'message',
    message: 'the-message',
    messageType: 'license-request'
  };
  const createSession = () => mockSession;

  videojs.xhr = (options) => {
    xhrCalls.push(options);
  };

  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return {
        createSession
      };
    }
  };

  standard5July2016({
    player: this.player,
    keySystemAccess,
    video: {
      setMediaKeys: (createdMediaKeys) => Promise.resolve(createdMediaKeys)
    },
    initDataType: '',
    initData: '',
    options: {
      keySystems: {
        'com.widevine.alpha': {
          url: 'some-url',
          licenseHeaders: {
            'Some-Header': 'priority-header-value'
          }
        }
      },
      emeHeaders: {
        'Some-Header': 'lower-priority-header-value'
      }
    },
    eventBus: mockEventBus
  }).catch((e) => {});

  setTimeout(() => {
    // Simulate 'message' event
    mockSession.listeners[0].listener(mockMessageEvent);

    assert.equal(mockEventBus.calls[0].type, 'keysystemaccesscomplete', 'keysystemaccesscomplete fired');
    assert.deepEqual(mockEventBus.calls[0].mediaKeys, { createSession }, 'keysystemaccesscomplete payload');
    assert.equal(mockEventBus.calls[1].type, 'keysessioncreated', 'keymessage fired');
    assert.equal(mockEventBus.calls[1].keySession, mockSession, 'keymessage payload');
    assert.equal(mockEventBus.calls[2].type, 'keymessage', 'keymessage event is expected message event');
    assert.equal(mockEventBus.calls[2].messageEvent, mockMessageEvent, 'keymessage event is expected message event');
    assert.equal(xhrCalls.length, 1, 'made one XHR');
    assert.deepEqual(xhrCalls[0], {
      uri: 'some-url',
      method: 'POST',
      responseType: 'arraybuffer',
      requestType: 'license',
      metadata: { keySystem: 'com.widevine.alpha' },
      body: 'the-message',
      headers: {
        'content-type': 'application/octet-stream',
        'some-header': 'priority-header-value'
      }
    }, 'made request with proper licenseHeaders value');

    videojs.xhr = origXhr;

    done();
  });
});

QUnit.test('sets required fairplay defaults if not explicitly configured', function(assert) {
  const origRequestMediaKeySystemAccess = window.navigator.requestMediaKeySystemAccess;

  window.navigator.requestMediaKeySystemAccess = (keySystem, systemOptions) => {
    assert.ok(
      systemOptions[0].initDataTypes.indexOf('sinf') !== -1,
      'includes required initDataType'
    );
    assert.ok(
      systemOptions[0].videoCapabilities[0].contentType.indexOf('video/mp4') !== -1,
      'includes required video contentType'
    );
  };

  getSupportedKeySystem({'com.apple.fps': {}});

  window.requestMediaKeySystemAccess = origRequestMediaKeySystemAccess;
});

QUnit.test('makeNewRequest triggers keysessioncreated', function(assert) {
  const done = assert.async();
  const mockSession = getMockSession();

  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => mockSession
    },
    eventBus: {
      trigger: (event) => {
        if (event.type === 'keysessioncreated') {
          assert.ok(true, 'got a keysessioncreated event');
          done();
        }
      },
      isDisposed: () => {
        return false;
      }
    }
  });
});

QUnit.test.skip('keySession is closed when player is disposed', function(assert) {
  const mockSession = getMockSession();
  const done = assert.async();

  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => mockSession
    },
    eventBus: {
      trigger: (event) => {
        if (event.type === 'keysessionclosed') {
          assert.ok(true, 'got a keysessionclosed event');
          done();
        }
      },
      isDisposed: () => {
        return false;
      }
    }
  });

  assert.equal(mockSession.numCloses, 0, 'no close() calls initially');

  this.player.dispose();

  assert.equal(mockSession.numCloses, 1, 'close() called once after dipose');
});

QUnit.test('emeError is called when keySession.close fails', function(assert) {
  const mockSession = getMockSession();
  const done = assert.async();
  const expectedErrorMessage = 'Failed to close session';

  mockSession.close = () => {
    return Promise.reject(expectedErrorMessage);
  };
  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => mockSession
    },
    eventBus: {
      trigger: () => {},
      isDisposed: () => {
        return false;
      }
    },
    emeError: (error, metadata) => {
      assert.equal(error, expectedErrorMessage, 'expected eme error message');
      assert.equal(metadata.errorType, videojs.Error.EMEFailedToCloseSession, 'expected eme error type');
      done();
    }
  });
  this.player.dispose();
});

QUnit.test('emeError called when session.generateRequest fails', function(assert) {
  const mockSession = getMockSession();
  const done = assert.async();
  const expectedErrorMessage = 'generate request failed';

  mockSession.generateRequest = () => {
    return Promise.reject(expectedErrorMessage);
  };
  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => mockSession
    },
    eventBus: {
      trigger: () => {},
      isDisposed: () => {
        return false;
      }
    },
    emeError: (error, metadata) => {
      assert.equal(error, expectedErrorMessage, 'expected eme error message');
      assert.equal(metadata.errorType, videojs.Error.EMEFailedToGenerateLicenseRequest, 'expected eme error type');
    }
  }).catch((error) => {
    assert.equal(error, 'Unable to create or initialize key session', 'expected message');
    done();
  });
});

QUnit.test('emeError called when mediaKeys.createSession fails', function(assert) {
  const done = assert.async();
  const expectedError = new Error('session could not be created');

  makeNewRequest(this.player, {
    mediaKeys: {
      createSession: () => {
        throw expectedError;
      }
    },
    eventBus: {
      trigger: () => {}
    },
    emeError: (error, metadata) => {
      assert.equal(error, expectedError, 'expected eme error message');
      assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeySession, 'expected eme error type');
      done();
    }
  });
});

QUnit.module('session management', {
  beforeEach() {
    this.fixture = document.getElementById('qunit-fixture');
    this.video = document.createElement('video');
    this.fixture.appendChild(this.video);
    this.player = videojs(this.video);
  }
});

QUnit.test('addSession saves options', function(assert) {
  const video = {
    pendingSessionData: []
  };
  const initDataType = 'temporary';
  const initData = new Uint8Array();
  const options = { some: 'option' };
  const getLicense = () => '';
  const removeSession = () => '';
  const eventBus = { trigger: () => {} };
  const contentId = null;
  const emeError = () => {};

  addSession({
    video,
    contentId,
    initDataType,
    initData,
    options,
    getLicense,
    removeSession,
    eventBus,
    emeError
  });

  assert.deepEqual(
    video.pendingSessionData,
    [{
      initDataType,
      initData,
      options,
      getLicense,
      removeSession,
      eventBus,
      contentId,
      emeError,
      keySystem: undefined
    }],
    'saved options into pendingSessionData array'
  );
});

QUnit.test('addPendingSessions reuses saved options', function(assert) {
  assert.expect(5);

  const done = assert.async();
  const options = { some: 'option' };
  const getLicense = (emeOptions, message) => {
    assert.deepEqual(emeOptions, options, 'used pending session data options');
    return Promise.resolve('license');
  };
  const eventListeners = [];
  const pendingSessionData = [{
    initDataType: 'temporary',
    initData: new Uint8Array(),
    options,
    getLicense,
    removeSession: () => '',
    eventBus: {
      trigger: () => {},
      isDisposed: () => {
        return false;
      }
    }
  }];
  const video = {
    pendingSessionData,
    // internal API, not used in this test
    setMediaKeys: () => Promise.resolve()
  };
  const createdMediaKeys = {
    createSession: () => {
      return {
        addEventListener: (event, callback) => eventListeners.push({ event, callback }),
        generateRequest: (initDataType, initData) => {
          assert.equal(
            initDataType,
            pendingSessionData[0].initDataType,
            'generateRequest received correct initDataType'
          );
          assert.equal(
            initData,
            pendingSessionData[0].initData,
            'generateRequest received correct initData'
          );
          assert.equal(eventListeners.length, 2, 'added two event listeners');
          assert.equal(
            eventListeners[0].event,
            'message',
            'added listener for message event'
          );
          // callback should call getLicense, which continues this test
          eventListeners[0].callback({messageType: 'license-request', message: 'test message'});
          return Promise.resolve();
        },
        // this call and everything after is beyond the scope of this test
        update: () => Promise.resolve(),
        close: () => {}
      };
    }
  };

  return addPendingSessions({
    player: this.player,
    video,
    createdMediaKeys
  }).then((resolve, reject) => {
    done();
  });
});

QUnit.module('videojs-contrib-eme getSupportedConfigurations', {
  beforeEach() {
    this.fixture = document.getElementById('qunit-fixture');
    this.video = document.createElement('video');
    this.fixture.appendChild(this.video);
    this.player = videojs(this.video);
  }
});

QUnit.test('includes audio and video content types', function(assert) {
  assert.deepEqual(
    getSupportedConfigurations('com.widevine.alpha', {
      audioContentType: 'audio/mp4; codecs="mp4a.40.2"',
      videoContentType: 'video/mp4; codecs="avc1.42E01E"'
    }),
    [{
      audioCapabilities: [{
        contentType: 'audio/mp4; codecs="mp4a.40.2"'
      }],
      videoCapabilities: [{
        contentType: 'video/mp4; codecs="avc1.42E01E"'
      }]
    }],
    'included audio and video content types'
  );
});

QUnit.test('includes audio and video robustness', function(assert) {
  assert.deepEqual(
    getSupportedConfigurations('com.widevine.alpha', {
      audioRobustness: 'SW_SECURE_CRYPTO',
      videoRobustness: 'SW_SECURE_CRYPTO'
    }),
    [{
      audioCapabilities: [{
        robustness: 'SW_SECURE_CRYPTO'
      }],
      videoCapabilities: [{
        robustness: 'SW_SECURE_CRYPTO'
      }]
    }],
    'included audio and video robustness'
  );
});

QUnit.test('includes audio and video content types and robustness', function(assert) {
  assert.deepEqual(
    getSupportedConfigurations('com.widevine.alpha', {
      audioContentType: 'audio/mp4; codecs="mp4a.40.2"',
      audioRobustness: 'SW_SECURE_CRYPTO',
      videoContentType: 'video/mp4; codecs="avc1.42E01E"',
      videoRobustness: 'SW_SECURE_CRYPTO'
    }),
    [{
      audioCapabilities: [{
        contentType: 'audio/mp4; codecs="mp4a.40.2"',
        robustness: 'SW_SECURE_CRYPTO'
      }],
      videoCapabilities: [{
        contentType: 'video/mp4; codecs="avc1.42E01E"',
        robustness: 'SW_SECURE_CRYPTO'
      }]
    }],
    'included audio and video content types and robustness'
  );
});

QUnit.test('includes persistentState', function(assert) {
  assert.deepEqual(
    getSupportedConfigurations('com.widevine.alpha', { persistentState: 'optional' }),
    [{ persistentState: 'optional' }],
    'included persistentState'
  );
});

QUnit.test('uses supportedConfigurations directly if provided', function(assert) {
  assert.deepEqual(
    getSupportedConfigurations('com.widevine.alpha', {
      supportedConfigurations: [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{
          contentType: 'audio/mp4; codecs="mp4a.40.2"',
          robustness: 'SW_SECURE_CRYPTO',
          extraOption: 'audio-extra'
        }],
        videoCapabilities: [{
          contentType: 'video/mp4; codecs="avc1.42E01E"',
          robustness: 'SW_SECURE_CRYPTO',
          extraOption: 'video-extra'
        }]
      }],
      // should not be used
      audioContentType: 'audio/mp4; codecs="mp4a.40.5"',
      audioRobustness: 'HW_SECURE_CRYPTO',
      videoContentType: 'video/mp4; codecs="avc1.42001e"',
      videoRobustness: 'HW_SECURE_CRYPTO'
    }),
    [{
      initDataTypes: ['cenc'],
      audioCapabilities: [{
        contentType: 'audio/mp4; codecs="mp4a.40.2"',
        robustness: 'SW_SECURE_CRYPTO',
        extraOption: 'audio-extra'
      }],
      videoCapabilities: [{
        contentType: 'video/mp4; codecs="avc1.42E01E"',
        robustness: 'SW_SECURE_CRYPTO',
        extraOption: 'video-extra'
      }]
    }],
    'used supportedConfigurations directly'
  );
});
