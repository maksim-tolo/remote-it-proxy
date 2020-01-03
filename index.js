const axios = require('axios');
const proxy = require('http-proxy-middleware');
const express = require('express');
const pRetry = require('p-retry');

const app = express();

const MILLISECONDS_IN_SECOND = 1000;

const remoteItHost = process.env.REMOTEIT_HOST || 'https://api.remot3.it/apv/v27';
const appPort = process.env.PORT || 3000;
const targetServiceName = process.env.REMOTEIT_TARGET_SERVICE_NAME;
const developerkey = process.env.REMOTEIT_DEVELOPER_KEY;
const username = process.env.REMOTEIT_USERNAME;
const password = process.env.REMOTEIT_PASSWORD;

let cachedProxy;
let cachedToken;

let tokenRefreshTimeout;
let proxyRefreshTimeout;

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
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
    tokenRefreshTimeout = null;
  }

  const { data, headers } = await loginToRemoteIt();
  const currentDate = (new Date(headers.date)).valueOf() || Date.now();
  const expirationDate = data.auth_expiration * MILLISECONDS_IN_SECOND;
  const timeout = expirationDate - currentDate;

  cachedToken = data.token;

  if (timeout) {
    setTimeout(refreshToken, timeout);
  }
}

async function refreshProxy() {
  if (proxyRefreshTimeout) {
    clearTimeout(proxyRefreshTimeout);
    proxyRefreshTimeout = null;
  }

  const { data: { devices } } = await getDevices(cachedToken);
  const { deviceaddress } = devices.find(({ devicealias }) => devicealias === targetServiceName);
  const { data: { connection } } = await connectToDevice(cachedToken, deviceaddress);
  const timeout = connection.expirationsec * MILLISECONDS_IN_SECOND;

  // TODO: Add error handlers for 403 status code
  cachedProxy = proxy({
    target: connection.proxy,
    changeOrigin: true,
    ws: true
  });

  if (timeout) {
    setTimeout(refreshProxy, timeout);
  }
}

async function getProxy() {
  if (!cachedProxy) {
    if (!cachedToken) {
      await refreshToken();
    }

    await refreshProxy();
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
