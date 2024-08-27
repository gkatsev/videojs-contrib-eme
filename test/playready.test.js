import QUnit from 'qunit';
import {
  getMessageContents,
  requestPlayreadyLicense
} from '../src/playready';
import {
  createMessageBuffer,
  challengeElement,
  unwrappedPlayreadyMessage
} from './playready-message';
import videojs from 'video.js';

QUnit.module('playready');

QUnit.test('getMessageContents parses message contents', function(assert) {
  const {headers, message} = getMessageContents(createMessageBuffer());

  assert.deepEqual(
    headers,
    {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
    },
    'parses headers'
  );
  assert.deepEqual(message, challengeElement, 'parses challenge element');
});

QUnit.test('getMessageContents parses utf-8 contents', function(assert) {
  const encoder = new TextEncoder();
  const encodedMessageData = encoder.encode(unwrappedPlayreadyMessage);
  const {headers, message} = getMessageContents(encodedMessageData);

  assert.deepEqual(
    headers,
    {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
    },
    'parses headers'
  );
  assert.deepEqual(message, encodedMessageData, 'parses challenge element');
});

QUnit.test('emeHeaders sent with license requests', function(assert) {
  const origXhr = videojs.xhr;
  const emeOptions = {
    emeHeaders: {
      'Some-Header': 'some-header-value'
    }
  };
  const keySystemOptions = {
    url: 'some-url',
    licenseHeaders: {}
  };
  const xhrCalls = [];

  videojs.xhr = (xhrOptions) => {
    xhrCalls.push(xhrOptions);
  };

  requestPlayreadyLicense('com.microsoft.playready', keySystemOptions, createMessageBuffer(), emeOptions);

  assert.equal(xhrCalls.length, 1, 'made one XHR');
  assert.deepEqual(xhrCalls[0], {
    uri: 'some-url',
    method: 'post',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
      'some-header': 'some-header-value'
    },
    body: challengeElement,
    responseType: 'arraybuffer',
    requestType: 'license',
    metadata: { keySystem: 'com.microsoft.playready' }
  }, 'license request sent with correct headers');

  videojs.xhr = origXhr;
});

QUnit.test('licenseHeaders property overrides emeHeaders', function(assert) {
  const origXhr = videojs.xhr;
  const emeOptions = {
    emeHeaders: {
      'Some-Header': 'some-header-value'
    }
  };
  const keySystemOptions = {
    url: 'some-url',
    licenseHeaders: {
      'Some-Header': 'priority-header-value'
    }
  };
  const xhrCalls = [];

  videojs.xhr = (xhrOptions) => {
    xhrCalls.push(xhrOptions);
  };

  requestPlayreadyLicense('com.microsoft.playready', keySystemOptions, createMessageBuffer(), emeOptions);

  assert.equal(xhrCalls.length, 1, 'made one XHR');
  assert.deepEqual(xhrCalls[0], {
    uri: 'some-url',
    method: 'post',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
      'some-header': 'priority-header-value'
    },
    body: challengeElement,
    responseType: 'arraybuffer',
    requestType: 'license',
    metadata: { keySystem: 'com.microsoft.playready' }
  }, 'license request sent with correct headers');

  videojs.xhr = origXhr;
});
