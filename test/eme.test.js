import QUnit from 'qunit';
import videojs from 'video.js';
import {
  standard5July2016,
  makeNewRequest,
  getSupportedKeySystem
} from '../src/eme';

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
        then: (nextCall) => nextCall()
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

QUnit.module('videojs-contrib-eme eme');

QUnit.test('keystatuseschange triggers keystatuschange on eventBus for each key', function(assert) {
  const callCount = {total: 0, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}};
  const initData = new Uint8Array([1, 2, 3]);
  const mockSession = getMockSession();
  const eventBus = {
    trigger: (event) => {
      if (!callCount[event.keyId][event.status]) {
        callCount[event.keyId][event.status] = 0;
      }
      callCount[event.keyId][event.status]++;
      callCount.total++;
    }
  };

  makeNewRequest({
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
  assert.equal(mockSession.listeners[1].type,
    'keystatuseschange',
    'added keystatuseschange listener');

  // no key statuses
  mockSession.listeners[1].listener();

  assert.equal(callCount.total, 0, 'no events dispatched yet');

  mockSession.keyStatuses.set(1, 'unrecognized');
  mockSession.keyStatuses.set(2, 'expired');
  mockSession.keyStatuses.set(3, 'internal-error');
  mockSession.keyStatuses.set(4, 'output-restricted');
  mockSession.keyStatuses.set(5, 'output-restricted');

  mockSession.listeners[1].listener();
  assert.equal(callCount[1].unrecognized, 1,
    'dispatched `unrecognized` key status for key 1');
  assert.equal(callCount[2].expired, 1,
    'dispatched `expired` key status for key 2');
  assert.equal(callCount[3]['internal-error'], 1,
    'dispatched `internal-error` key status for key 3');
  assert.equal(callCount[4]['output-restricted'], 1,
    'dispatched `output-restricted` key status for key 4');
  assert.equal(callCount[5]['output-restricted'], 1,
    'dispatched `output-restricted` key status for key 5');
  assert.equal(callCount.total, 5, '5 keystatuschange events received so far');

  // Change a single key and check that it's triggered for all keys
  mockSession.keyStatuses.set(1, 'usable');

  mockSession.listeners[1].listener();
  assert.equal(callCount[1].usable, 1,
    'dispatched `usable` key status for key 1');
  assert.equal(callCount[2].expired, 2,
    'dispatched `expired` key status for key 2');
  assert.equal(callCount[3]['internal-error'], 2,
    'dispatched `internal-error` key status for key 3');
  assert.equal(callCount[4]['output-restricted'], 2,
    'dispatched `output-restricted` key status for key 4');
  assert.equal(callCount[5]['output-restricted'], 2,
    'dispatched `output-restricted` key status for key 5');
  assert.equal(callCount.total, 10, '10 keystatuschange events received so far');

  // Change the key statuses and recheck
  mockSession.keyStatuses.set(1, 'output-downscaled');
  mockSession.keyStatuses.set(2, 'released');
  mockSession.keyStatuses.set(3, 'usable');
  mockSession.keyStatuses.set(4, 'status-pending');
  mockSession.keyStatuses.set(5, 'usable');

  mockSession.listeners[1].listener();
  assert.equal(callCount[1]['output-downscaled'], 1,
    'dispatched `output-downscaled` key status for key 1');
  assert.equal(callCount[2].released, 1,
    'dispatched `released` key status for key 2');
  assert.equal(callCount[3].usable, 1,
    'dispatched `usable` key status for key 3');
  assert.equal(callCount[4]['status-pending'], 1,
    'dispatched `status-pending` key status for key 4');
  assert.equal(callCount[5].usable, 1,
    'dispatched `usable` key status for key 5');
  assert.equal(callCount.total, 15, '15 keystatuschange events received so far');

});

QUnit.test('keystatuseschange with expired key closes session', function(assert) {
  const removeSessionCalls = [];
  // once the eme module gets the removeSession function, the session argument is already
  // bound to the function (note that it's a custom session maintained by the plugin, not
  // the native session), so only initData is passed
  const removeSession = (initData) => removeSessionCalls.push(initData);
  const initData = new Uint8Array([1, 2, 3]);
  const mockSession = getMockSession();
  const eventBus = {
    trigger: (name) => {}
  };

  makeNewRequest({
    mediaKeys: {
      createSession: () => mockSession
    },
    initDataType: '',
    initData,
    options: {},
    getLicense() {},
    removeSession,
    eventBus
  });

  assert.equal(mockSession.listeners.length, 2, 'added listeners');
  assert.equal(mockSession.listeners[1].type,
    'keystatuseschange',
    'added keystatuseschange listener');
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
});

QUnit.test('keystatuseschange with internal-error logs a warning', function(assert) {
  const origWarn = videojs.log.warn;
  const initData = new Uint8Array([1, 2, 3]);
  const mockSession = getMockSession();
  const warnCalls = [];
  const eventBus = {
    trigger: (name) => {}
  };

  videojs.log.warn = (...args) => warnCalls.push(args);

  makeNewRequest({
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
  assert.equal(mockSession.listeners[1].type,
    'keystatuseschange',
    'added keystatuseschange listener');

  // no key statuses
  mockSession.listeners[1].listener();

  assert.equal(warnCalls.length, 0, 'no warn logs');

  mockSession.keyStatuses.set(1, 'internal-error');

  const keyStatusChangeEvent = {};

  mockSession.listeners[1].listener(keyStatusChangeEvent);

  assert.equal(warnCalls.length, 1, 'one warn log');
  assert.equal(warnCalls[0][0],
    'Key status reported as "internal-error." Leaving the session open ' +
               'since we don\'t have enough details to know if this error is fatal.',
    'logged correct warning');
  assert.equal(warnCalls[0][1], keyStatusChangeEvent, 'logged event object');

  videojs.log.warn = origWarn;
});

QUnit.test('accepts a license URL as an option', function(assert) {
  const done = assert.async();
  const origXhr = videojs.xhr;
  const xhrCalls = [];
  const session = new videojs.EventTarget();

  videojs.xhr = (options) => {
    xhrCalls.push(options);
  };

  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return {
        createSession: () => session
      };
    }
  };

  standard5July2016({
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
    }
  }).catch((e) => {});

  setTimeout(() => {
    session.trigger({
      type: 'message',
      message: 'the-message'
    });

    assert.equal(xhrCalls.length, 1, 'made one XHR');
    assert.deepEqual(xhrCalls[0], {
      uri: 'some-url',
      method: 'POST',
      responseType: 'arraybuffer',
      body: 'the-message',
      headers: {
        'Content-type': 'application/octet-stream'
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
  const session = new videojs.EventTarget();
  const keySystemAccess = {
    keySystem: 'com.widevine.alpha',
    createMediaKeys: () => {
      return {
        createSession: () => session
      };
    }
  };

  videojs.xhr = (options) => {
    xhrCalls.push(options);
  };

  standard5July2016({
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
    }
  }).catch((e) => {});

  setTimeout(() => {
    session.trigger({
      type: 'message',
      message: 'the-message'
    });

    assert.equal(xhrCalls.length, 1, 'made one XHR');
    assert.deepEqual(xhrCalls[0], {
      uri: 'some-url',
      method: 'POST',
      responseType: 'arraybuffer',
      body: 'the-message',
      headers: {
        'Content-type': 'application/octet-stream'
      }
    }, 'made request with proper options');

    videojs.xhr = origXhr;

    done();
  });
});

QUnit.test('5 July 2016 lifecycle', function(assert) {
  assert.expect(33);

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
    licenseRequestAttempts: 0
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
    trigger: (name) => {
      if (name === 'licenserequestattempted') {
        callCounts.licenseRequestAttempts++;
      }
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
        }
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
  assert.equal(callCounts.licenseRequestAttempts, 0,
    'license request event not triggered (since no callback yet)');

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
    assert.equal(callCounts.licenseRequestAttempts, 0,
      'license request event not triggered (since no callback yet)');

    keySessionEventListeners.message({});

    // Step 3: get license
    assert.equal(callCounts.getCertificate, 1, 'certificate requested');
    assert.equal(callCounts.createMediaKeys, 1, 'media keys created');
    assert.equal(mediaKeys, setMediaKeys, 'media keys set');
    assert.equal(callCounts.createSession, 1, 'key session created');
    assert.equal(callCounts.keySessionGenerateRequest, 1, 'key session request made');
    assert.equal(callCounts.getLicense, 1, 'license requested');
    assert.equal(callCounts.keySessionUpdate, 0, 'key session not updated');
    assert.equal(callCounts.licenseRequestAttempts, 0,
      'license request event not triggered (since no callback yet)');

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
      assert.equal(callCounts.licenseRequestAttempts, 1,
        'license request event triggered');
      assert.equal(errors, 0, 'no errors occurred');
    });
  });
});

QUnit.test('getSupportedKeySystem error', function(assert) {

  // Skip this test in Safari, getSupportedKeySystem is never used in Safari.
  if (videojs.browser.IS_ANY_SAFARI) {
    assert.expect(0);
    return;
  }

  const done = assert.async(1);

  getSupportedKeySystem({'un.supported.keysystem': {}}).catch((err) => {
    assert.equal(err.name, 'NotSupportedError', 'keysystem access request fails');
    done();
  });
});

QUnit.test('errors when neither url nor getLicense is given', function(assert) {
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
    video: {},
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(
      err,
      'Error: Neither URL nor getLicense function provided to get license',
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

  standard5July2016({
    video: {},
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(err, 'error fetching certificate', 'correct error message');
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

  standard5July2016({
    video: {},
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(err, 'Failed to create and initialize a MediaKeys object',
      'uses generic message');
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

  standard5July2016({
    video: {},
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(err, 'failed creating mediaKeys', 'uses specific error when given');
    done();
  });

});

QUnit.test('rejects promise when setMediaKeys rejects', function(assert) {
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
        setServerCertificate: () => resolveReject(rejectSetServerCertificate,
          'setServerCertificate failed'),
        createSession: () => {
          return {
            addEventListener: () => {},
            generateRequest: () => resolveReject(rejectGenerateRequest,
              'generateRequest failed')
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
  const test = (errMessage, testDescription) => {
    video.mediaKeysObject = undefined;
    standard5July2016({
      video,
      keySystemAccess,
      options
    }).catch((err) => {
      assert.equal(err, errMessage, testDescription);
      done();
      if (callbacks[0]) {
        callbacks.shift()();
      }
    });
  };

  callbacks.push(() => {
    rejectSetServerCertificate = false;
    test('setMediaKeys failed', 'second promise fails');
  });
  callbacks.push(() => {
    rejectSetMediaKeys = false;
    test('Unable to create or initialize key session', 'third promise fails');
  });

  test('setServerCertificate failed', 'first promise fails');

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
                callback(options, {message: 'whatever'});
              });
            },
            keyStatuses: [],
            generateRequest: () => Promise.resolve()
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
    video,
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(err, 'error getting license', 'correct error message');
    done();
  });

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
                callback({message: 'whatever'});
              });
            },
            keyStatuses: [],
            generateRequest: () => Promise.resolve(),
            update: () => Promise.reject('keySession update failed')
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
    video,
    keySystemAccess,
    options
  }).catch((err) => {
    assert.equal(err, 'keySession update failed', 'correct error message');
    done();
  });

});
