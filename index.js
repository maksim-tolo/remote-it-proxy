const axios = require('axios');
const proxy = require('http-proxy-middleware');
const express = require('express');
const pRetry = require('p-retry');
const firebase = require('firebase/app');

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

const app = express();

firebase.initializeApp({
  apiKey: firebaseApiKey,
  authDomain: firebaseAuthDomain,
  databaseURL: firebaseDatabaseURL,
  storageBucket: firebaseStorageBucket
});

async function restoreSession() {
  try {
    const session = await firebase.database().ref('session').get();

    cachedProxyURL = session.proxy;
    cachedToken = session.token;
    tokenExpirationDate = session.tokenExpirationDate;
    proxyExpirationDate = session.proxyExpirationDate;
  } catch (e) {
    console.log('Unable to restore session');
  }
}

async function saveSession() {
  try {
    await firebase.database().ref('session').set({
      proxy: cachedProxyURL,
      token: cachedToken,
      tokenExpirationDate,
      proxyExpirationDate
    });
  } catch (e) {
    console.log('Unable to save session');
  }
}

function mutex(fn) {
  let promise;

  return async function () {
    // TODO: Return the promise only if args are not changed
    if (promise) {
      return promise;
    }

    promise = fn();

    const result = await promise;

    promise = null;

    return result;
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

  if (!tokenExpirationDate || !proxyExpirationDate) {
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

const getProxySingleExecution = mutex(getProxy);

app.use(async (req, res, next) => {
  try {
    const proxyMiddleware = await pRetry(getProxySingleExecution, {
      onFailedAttempt: () => {
        cachedToken = null;
        cachedProxy = null;
        cachedProxyURL = null;
      },
      retries: 5
    });

    return proxyMiddleware(req, res, next);
  } catch (e) {
    res.writeHead(500);
    res.end('Unable to connect to proxy server');
  }
});

app.listen(appPort, () => {
  console.log('App is running at port:', appPort);
});
