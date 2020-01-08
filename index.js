const axios = require('axios');
const proxy = require('http-proxy-middleware');
const express = require('express');
const pRetry = require('p-retry');
const firebase = require('firebase');

const MILLISECONDS_IN_SECOND = 1000;

const remoteItHost = process.env.REMOTEIT_HOST || 'https://api.remot3.it/apv/v27';
const appPort = process.env.PORT || 3000;
const targetServiceName = process.env.REMOTEIT_TARGET_SERVICE_NAME;
const developerkey = process.env.REMOTEIT_DEVELOPER_KEY;
const username = process.env.REMOTEIT_USERNAME;
const password = process.env.REMOTEIT_PASSWORD;
const firebaseApiKey = process.env.FIREBASE_API_KEY;
const firebaseAuthDomain = process.env.FIREBASE_AUTH_DOMAIN;
const firebaseDatabaseURL = process.env.FIREBASE_DATABASE_URL;
const firebaseStorageBucket = process.env.FIREBASE_STORAGE_BUCKET;

let cachedProxy;
let cachedProxyURL;
let cachedToken;

let tokenExpirationDate;
let proxyExpirationDate;

let isSessionRestored = false;

const app = express();

firebase.initializeApp({
  apiKey: firebaseApiKey,
  authDomain: firebaseAuthDomain,
  databaseURL: firebaseDatabaseURL,
  storageBucket: firebaseStorageBucket
});

async function restoreSession() {
  try {
    const snapshot = await firebase.database().ref('session').once('value');
    const session = snapshot.val();

    cachedProxyURL = session.proxy;
    cachedToken = session.token;
    tokenExpirationDate = session.tokenExpirationDate;
    proxyExpirationDate = session.proxyExpirationDate;

    isSessionRestored = true;

    console.log('Session has been restored successfully, data:', session);
  } catch (e) {
    isSessionRestored = true;

    console.log('Unable to restore session, error:', e.message);
  }
}

async function saveSession() {
  try {
    const session = {
      proxy: cachedProxyURL,
      token: cachedToken,
      tokenExpirationDate,
      proxyExpirationDate
    };

    await firebase.database().ref('session').set(session);

    console.log('Session has been saved successfully, data:', session);
  } catch (e) {
    console.log('Unable to save session, error:', e.message);
  }
}

function mutex(fn) {
  let promise;

  return async function () {
    // TODO: Return the promise only if args are not changed
    if (promise) {
      return promise;
    }

    try {
      promise = fn();

      const result = await promise;

      promise = null;

      return result;
    } catch (e) {
      promise = null;

      throw e;
    }
  }
}

async function loginToRemoteIt() {
  return axios
    .post(
      `${remoteItHost}/user/login`,
      { username, password },
      { headers: { developerkey } }
    );
}

async function getDevices(token) {
  return axios
    .get(
      `${remoteItHost}/device/list/all`, {
        headers: {
          developerkey,
          token
        }
      });
}

async function connectToDevice(token, deviceaddress) {
  return axios
    .post(
      `${remoteItHost}/device/connect`,
      {
        deviceaddress,
        wait: true
      }, {
        headers: {
          developerkey,
          token
        }
      }
    );
}

async function refreshToken() {
  const { data } = await loginToRemoteIt();

  tokenExpirationDate = data.auth_expiration * MILLISECONDS_IN_SECOND;
  cachedToken = data.token;
}

async function refreshProxy() {
  const { data: { devices } } = await getDevices(cachedToken);
  const { deviceaddress } = devices.find(({ devicealias }) => devicealias === targetServiceName);
  const { data: { connection } } = await connectToDevice(cachedToken, deviceaddress);
  const timeout = connection.expirationsec * MILLISECONDS_IN_SECOND;

  proxyExpirationDate = Date.now() + timeout;
  cachedProxyURL = connection.proxy;
}

async function getProxy() {
  const now = Date.now();

  if (!isSessionRestored) {
    await restoreSession();
  }

  if (tokenExpirationDate && now > tokenExpirationDate) {
    cachedToken = null;
  }

  if (proxyExpirationDate && now > proxyExpirationDate) {
    cachedProxyURL = null;
    cachedProxy = null;
  }

  if (!cachedProxy) {
    if (!cachedToken) {
      await refreshToken();
    }

    if (!cachedProxyURL) {
      await refreshProxy();
    }

    await saveSession();

    // TODO: Add error handlers for 403 status code
    cachedProxy = proxy({
      target: cachedProxyURL,
      changeOrigin: true,
      ws: true
    });
  }

  return cachedProxy;
}

async function getProxyRetryable() {
  return pRetry(getProxy, {
    onFailedAttempt: (e) => {
      console.log('Unable to start the proxy server, trying to refresh the session, error:', e.message);

      cachedToken = null;
      cachedProxy = null;
      cachedProxyURL = null;
    },
    retries: 5
  });
}

const getProxyLocked = mutex(getProxyRetryable);

app.use(async (req, res, next) => {
  try {
    const proxyMiddleware = await getProxyLocked();

    return proxyMiddleware(req, res, next);
  } catch (e) {
    res.writeHead(500);
    res.end('Unable to connect to the proxy server, error:', e.message);
  }
});

app.listen(appPort, () => {
  console.log('App is running at port:', appPort);
});
