import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js';
import {
  getAuth,
  signInWithPopup,
  signOut,
  GithubAuthProvider,
} from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js';
import { firebaseConfig } from './auth-extension-config.js';

let app;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

const auth = getAuth(app);
const parentOrigin = document.location.ancestorOrigins?.[0] ?? '*';

function postResult(message) {
  window.parent.postMessage(
    {
      source: 'flowlane-web-auth-helper',
      type: 'FLOWLANE_AUTH_RESULT',
      ...message,
    },
    parentOrigin,
  );
}


function createProvider(providerId) {
  switch (providerId) {
    case 'github': {
      const provider = new GithubAuthProvider();
      provider.addScope('read:user');
      provider.addScope('user:email');
      return provider;
    }
    default:
      throw new Error(`Unsupported provider: ${providerId}`);
  }
}

function extractPayload(providerId, result) {
  switch (providerId) {
    case 'github': {
      const credential = GithubAuthProvider.credentialFromResult(result);
      return { accessToken: credential?.accessToken ?? null };
    }
    default:
      throw new Error(`Unsupported provider: ${providerId}`);
  }
}

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent) return;
  if (parentOrigin !== '*' && event.origin !== parentOrigin) return;

  const data = event.data;
  if (!data || data.source !== 'flowlane-extension-offscreen' || data.type !== 'FLOWLANE_AUTH_REQUEST') {
    return;
  }

  try {
    const provider = createProvider(data.providerId);
    const result = await signInWithPopup(auth, provider);
    const payload = extractPayload(data.providerId, result);
    await signOut(auth).catch(() => {});
    postResult({ requestId: data.requestId, ok: true, payload });
  } catch (error) {
    postResult({
      requestId: data.requestId,
      ok: false,
      error: error?.message ?? 'Authentication failed',
    });
  }
});



