import QUnit from 'qunit';
import videojs from 'video.js';
import window from 'global/window';
import {
  createMessageBuffer,
  challengeElement
} from './playready-message';
import {
  PLAYREADY_KEY_SYSTEM,
  createSession,
  default as msPrefixed
} from '../src/ms-prefixed';
import {
  stringToArrayBuffer,
  getMockEventBus
} from './utils';

QUnit.module('videojs-contrib-eme ms-prefixed', {
  beforeEach() {
    this.origMSMediaKeys = window.MSMediaKeys;
    window.MSMediaKeys = function() {};

    const session = new videojs.EventTarget();

    session.keys = [];
    session.update = (key) => session.keys.push(key);

    // mock the video since the APIs won't be available on non IE11 browsers
    const video = {
      msSetMediaKeys: () => {
        video.msKeys = {
          createSession: () => this.session
        };
      }
    };

    this.session = session;
    this.video = video;
  },
  afterEach() {
    window.MSMediaKeys = this.origMSMediaKeys;
  }
});

QUnit.test('overwrites msKeys', function(assert) {
  const origMsKeys = {};

  this.video.msKeys = origMsKeys;

  msPrefixed({
    video: this.video,
    initData: '',
    options: {
      keySystems: {
        'com.microsoft.playready': true
      }
    },
    eventBus: getMockEventBus()
  });

  assert.notEqual(this.video.msKeys, origMsKeys, 'overwrote msKeys');
});

QUnit.test('error thrown when creating keys bubbles up', function(assert) {
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeys, 'errorType is expected value');
    assert.equal(metadata.keySystem, PLAYREADY_KEY_SYSTEM, 'errorType is expected value');
  };

  window.MSMediaKeys = function() {
    throw new Error('error');
  };

  assert.throws(
    () => msPrefixed({video: this.video, emeError}),
    new Error('Unable to create media keys for PlayReady key system. Error: error'),
    'error is thrown with proper message'
  );
});

QUnit.test('createSession throws unknown error', function(assert) {
  const video = {
    msSetMediaKeys: () => {
      video.msKeys = {
        createSession: () => {
          throw new Error('whatever');
        }
      };
    }
  };

  assert.throws(
    () => msPrefixed({video}),
    new Error('whatever'),
    'error is thrown with proper message'
  );
});

QUnit.test('throws error if session was not created', function(assert) {
  const video = {
    msSetMediaKeys: () => {
      video.msKeys = {
        createSession: () => null
      };
    }
  };
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeySession, 'errorType is expected value');
    assert.equal(metadata.keySystem, PLAYREADY_KEY_SYSTEM, 'errorType is expected value');
  };

  assert.throws(
    () => msPrefixed({video, emeError}),
    new Error('Could not create key session.'),
    'error is thrown with proper message'
  );
});

QUnit.test('throws error on keysession mskeyerror event', function(assert) {
  let errorMessage;
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToCreateMediaKeySession, 'errorType is expected value');
    assert.equal(metadata.keySystem, PLAYREADY_KEY_SYSTEM, 'keySystem is expected value');
  };

  msPrefixed({
    video: this.video,
    initData: '',
    options: {
      keySystems: {
        'com.microsoft.playready': true
      }
    },
    eventBus: {
      trigger: (event) => {
        errorMessage = typeof event === 'string' ? event : event.message;
      },
      isDisposed: () => {
        return false;
      }
    },
    emeError
  });

  this.session.error = {
    code: 5,
    systemCode: 9
  };

  this.session.trigger('mskeyerror');

  assert.equal(
    errorMessage,
    'Unexpected key error from key session with code: 5 and systemCode: 9',
    'error is thrown with proper message'
  );
});

QUnit.test('calls getKey when provided on key message', function(assert) {
  let passedOptions = null;
  let passedDestinationURL = null;
  let passedBuffer = null;
  let passedCallback = null;
  let getKeyCallback = (callback) => {
    callback(null, 'a key');
  };
  let errorMessage;

  const emeOptions = {
    keySystems: {
      'com.microsoft.playready': {
        getKey: (options, destinationURL, buffer, callback) => {
          passedOptions = options;
          passedDestinationURL = destinationURL;
          passedBuffer = buffer;
          passedCallback = callback;
          getKeyCallback(callback);
        }
      }
    }
  };
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToRequestMediaKeySystemAccess, 'errorType is expected value');
    assert.deepEqual(metadata.config, [{}], 'keySystem is expected value');
  };

  msPrefixed({
    video: this.video,
    initData: '',
    options: emeOptions,
    eventBus: {
      trigger: (event) => {
        errorMessage = typeof event === 'string' ? event : event.message;
      },
      isDisposed: () => {
        return false;
      }
    },
    emeError
  });

  assert.notOk(passedOptions, 'getKey not called');

  this.session.trigger({
    type: 'mskeymessage',
    destinationURL: 'url',
    message: {
      buffer: 'buffer'
    }
  });

  assert.equal(passedOptions, emeOptions, 'getKey called with options');
  assert.equal(passedDestinationURL, 'url', 'getKey called with destinationURL');
  assert.equal(passedBuffer, 'buffer', 'getKey called with buffer');
  assert.equal(typeof passedCallback, 'function', 'getKey called with callback');
  assert.equal(this.session.keys.length, 1, 'added key to session');
  assert.equal(this.session.keys[0], 'a key', 'added correct key to session');

  getKeyCallback = (callback) => {
    callback('an error', 'an errored key');
  };

  this.session.trigger({
    type: 'mskeymessage',
    destinationURL: 'url',
    message: {
      buffer: 'buffer'
    }
  });

  assert.equal(
    errorMessage,
    'Unable to get key: an error',
    'fires mskeyerror on eventBus when callback has an error'
  );
  assert.equal(this.session.keys.length, 1, 'did not add a new key');
});

QUnit.test('makes request when nothing provided on key message', function(assert) {
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  let errorMessage;
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToGenerateLicenseRequest, 'errorType is expected value');
    assert.equal(metadata.keySystem, PLAYREADY_KEY_SYSTEM, 'keySystem is expected value');
  };

  videojs.xhr = (config, callback) => xhrCalls.push({config, callback});

  msPrefixed({
    video: this.video,
    initData: '',
    options: {
      keySystems: {
        'com.microsoft.playready': true
      }
    },
    eventBus: {
      trigger: (event) => {
        if (typeof event === 'object' && event.type === 'mskeyerror') {
          errorMessage = event.message;
        }
      },
      isDisposed: () => {
        return false;
      }
    },
    emeError
  });
  this.session.trigger({
    type: 'mskeymessage',
    destinationURL: 'destination-url',
    message: {
      buffer: createMessageBuffer()
    }
  });

  assert.equal(xhrCalls.length, 1, 'one xhr request');
  assert.equal(
    xhrCalls[0].config.uri,
    'destination-url',
    'made request to destinationURL'
  );
  assert.deepEqual(
    xhrCalls[0].config.headers,
    {
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
    },
    'uses headers from message'
  );
  assert.equal(xhrCalls[0].config.body, challengeElement, 'sends the challenge element');
  assert.equal(xhrCalls[0].config.method, 'post', 'request is a post');
  assert.equal(
    xhrCalls[0].config.responseType,
    'arraybuffer',
    'responseType is an arraybuffer'
  );

  const response = {
    body: stringToArrayBuffer('key value')
  };

  xhrCalls[0].callback('an error', response, response.body);

  assert.equal(
    errorMessage,
    'Unable to request key from url: destination-url',
    'triggers mskeyerror on event bus when callback has an error'
  );
  assert.equal(this.session.keys.length, 0, 'no key added to session');

  xhrCalls[0].callback(null, response, response.body);

  assert.equal(this.session.keys.length, 1, 'key added to session');
  assert.deepEqual(
    this.session.keys[0],
    new Uint8Array(response.body),
    'correct key added to session'
  );

  videojs.xhr = origXhr;
});

QUnit.test(
  'makes request on key message when empty object provided in options',
  function(assert) {
    const origXhr = videojs.xhr;
    const xhrCalls = [];

    videojs.xhr = (config, callback) => xhrCalls.push({config, callback});

    msPrefixed({
      video: this.video,
      initData: '',
      options: {
        keySystems: {
          'com.microsoft.playready': {}
        }
      },
      eventBus: getMockEventBus()
    });
    this.session.trigger({
      type: 'mskeymessage',
      destinationURL: 'destination-url',
      message: {
        buffer: createMessageBuffer()
      }
    });

    assert.equal(xhrCalls.length, 1, 'one xhr request');
    assert.equal(
      xhrCalls[0].config.uri,
      'destination-url',
      'made request to destinationURL'
    );
    assert.deepEqual(
      xhrCalls[0].config.headers,
      {
        'content-type': 'text/xml; charset=utf-8',
        'soapaction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
      },
      'uses headers from message'
    );
    assert.equal(xhrCalls[0].config.body, challengeElement, 'sends the challenge element');
    assert.equal(xhrCalls[0].config.method, 'post', 'request is a post');
    assert.equal(
      xhrCalls[0].config.responseType,
      'arraybuffer',
      'responseType is an arraybuffer'
    );

    videojs.xhr = origXhr;
  }
);

QUnit.test('makes request with provided url string on key message', function(assert) {
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  let errorMessage;
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToGenerateLicenseRequest, 'errorType is expected value');
    assert.equal(metadata.keySystem, PLAYREADY_KEY_SYSTEM, 'keySystem is expected value');
  };

  videojs.xhr = (config, callback) => xhrCalls.push({config, callback});

  msPrefixed({
    video: this.video,
    initData: '',
    options: {
      keySystems: {
        'com.microsoft.playready': 'provided-url'
      }
    },
    eventBus: {
      trigger: (event) => {
        if (typeof event === 'object' && event.type === 'mskeyerror') {
          errorMessage = event.message;
        }
      },
      isDisposed: () => {
        return false;
      }
    },
    emeError
  });
  this.session.trigger({
    type: 'mskeymessage',
    destinationURL: 'destination-url',
    message: {
      buffer: createMessageBuffer([{
        name: 'Content-Type',
        value: 'text/xml; charset=utf-8'
      }, {
        name: 'SOAPAction',
        value: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
      }])
    }
  });

  assert.equal(xhrCalls.length, 1, 'one xhr request');
  assert.equal(
    xhrCalls[0].config.uri,
    'provided-url',
    'made request to provided-url'
  );
  assert.deepEqual(
    xhrCalls[0].config.headers,
    {
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
    },
    'uses headers from message'
  );
  assert.equal(xhrCalls[0].config.body, challengeElement, 'sends the challenge element');
  assert.equal(xhrCalls[0].config.method, 'post', 'request is a post');
  assert.equal(
    xhrCalls[0].config.responseType,
    'arraybuffer',
    'responseType is an arraybuffer'
  );

  const response = {
    body: stringToArrayBuffer('key value')
  };

  xhrCalls[0].callback('an error', response, response.body);

  assert.equal(
    errorMessage,
    'Unable to request key from url: provided-url',
    'triggers mskeyerror on event bus when callback has an error'
  );
  assert.equal(this.session.keys.length, 0, 'no key added to session');

  xhrCalls[0].callback(null, response, response.body);

  assert.equal(this.session.keys.length, 1, 'key added to session');
  assert.deepEqual(
    this.session.keys[0],
    new Uint8Array(response.body),
    'correct key added to session'
  );

  videojs.xhr = origXhr;
});

QUnit.test('makes request with provided url on key message', function(assert) {
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  const callCounts = {
    licenseRequestAttempts: 0
  };
  let errorMessage;
  const emeError = (_, metadata) => {
    assert.equal(metadata.errorType, videojs.Error.EMEFailedToGenerateLicenseRequest, 'errorType is expected value');
    assert.equal(metadata.keySystem, PLAYREADY_KEY_SYSTEM, 'keySystem is expected value');
  };

  videojs.xhr = (config, callback) => xhrCalls.push({config, callback});

  msPrefixed({
    video: this.video,
    initData: '',
    options: {
      keySystems: {
        'com.microsoft.playready': {
          url: 'provided-url'
        }
      }
    },
    eventBus: {
      trigger: (event) => {
        if (event.type === 'licenserequestattempted') {
          callCounts.licenseRequestAttempts++;
        } else if (typeof event === 'object' && event.type === 'mskeyerror') {
          errorMessage = event.message;
        }
      },
      isDisposed: () => {
        return false;
      }
    },
    emeError
  });
  this.session.trigger({
    type: 'mskeymessage',
    destinationURL: 'destination-url',
    message: {
      buffer: createMessageBuffer([{
        name: 'Content-Type',
        value: 'text/xml; charset=utf-8'
      }, {
        name: 'SOAPAction',
        value: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
      }])
    }
  });

  assert.equal(xhrCalls.length, 1, 'one xhr request');
  assert.equal(
    xhrCalls[0].config.uri,
    'provided-url',
    'made request to provided-url'
  );
  assert.deepEqual(
    xhrCalls[0].config.headers,
    {
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
    },
    'uses headers from message'
  );
  assert.equal(xhrCalls[0].config.body, challengeElement, 'sends the challenge element');
  assert.equal(xhrCalls[0].config.method, 'post', 'request is a post');
  assert.equal(
    xhrCalls[0].config.responseType,
    'arraybuffer',
    'responseType is an arraybuffer'
  );
  assert.equal(
    callCounts.licenseRequestAttempts, 0,
    'license request event not triggered (since no callback yet)'
  );

  const response = {
    body: stringToArrayBuffer('key value')
  };

  xhrCalls[0].callback('an error', response, response.body);

  assert.equal(callCounts.licenseRequestAttempts, 1, 'license request event triggered');
  assert.equal(
    errorMessage,
    'Unable to request key from url: provided-url',
    'triggers mskeyerror on event bus when callback has an error'
  );
  assert.equal(this.session.keys.length, 0, 'no key added to session');

  xhrCalls[0].callback(null, response, response.body);

  assert.equal(
    callCounts.licenseRequestAttempts, 2,
    'second license request event triggered'
  );
  assert.equal(this.session.keys.length, 1, 'key added to session');
  assert.deepEqual(
    this.session.keys[0],
    new Uint8Array(response.body),
    'correct key added to session'
  );

  videojs.xhr = origXhr;
});

QUnit.test('will use a custom getLicense method if one is provided', function(assert) {
  let callCount = 0;

  msPrefixed({
    video: this.video,
    initData: '',
    options: {
      keySystems: {
        'com.microsoft.playready': {
          getLicense() {
            callCount++;
          }
        }
      }
    },
    eventBus: getMockEventBus()
  });

  const buffer = createMessageBuffer([{
    name: 'Content-Type',
    value: 'text/xml; charset=utf-8'
  }, {
    name: 'SOAPAction',
    value: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
  }]);

  this.session.trigger({
    type: 'mskeymessage',
    destinationURL: 'destination-url',
    message: {buffer}
  });

  assert.equal(callCount, 1, 'getLicense was called');
});

QUnit.test('createSession triggers keysessioncreated', function(assert) {
  const addEventListener = () => {};
  const video = {
    msKeys: {
      createSession: () => {
        return {
          addEventListener
        };
      }
    }
  };
  const eventBus = getMockEventBus();

  createSession(video, '', {}, eventBus);

  assert.equal(eventBus.calls.length, 1, 'one event triggered');
  assert.equal(
    eventBus.calls[0].type,
    'keysessioncreated',
    'triggered keysessioncreated event'
  );
  assert.deepEqual(eventBus.calls[0].keySession, { addEventListener }, 'keysessioncreated payload');
});
