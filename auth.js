// Thin wrapper around Firebase Auth + Firestore so game.js never has to
// touch the Firebase SDK directly. Falls back to a no-op "guest mode" if
// firebase-config.js still has placeholder values or the SDK failed to load
// (e.g. offline) — the game works exactly as before in that case.
(() => {
  'use strict';

  const cfg = window.FIREBASE_CONFIG;
  const configured = !!(cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY_HERE' && window.firebase);

  let auth = null;
  let db = null;
  let currentUser = null;
  let ready = false;
  const readyCallbacks = [];

  function fireReady() {
    ready = true;
    readyCallbacks.splice(0).forEach(cb => cb(currentUser));
  }

  if (configured) {
    firebase.initializeApp(cfg);
    auth = firebase.auth();
    db = firebase.firestore();
    auth.onAuthStateChanged(user => {
      currentUser = user;
      fireReady();
    });
  } else {
    // No backend configured yet — behave as if signed out, immediately.
    setTimeout(fireReady, 0);
  }

  function normalize(username) {
    return String(username || '').trim().toLowerCase();
  }

  // The account's real email — collected at signup so Firebase's built-in
  // password-reset email actually reaches the player. The username -> email
  // lookup doc has to be publicly readable so login-by-username can find it
  // before the user is authenticated, which does mean a real email is
  // fetchable by anyone who already knows (or guesses) a valid username —
  // an accepted trade-off for a small friends/family game with no backend.
  async function signup(username, email, password) {
    username = normalize(username);
    email = String(email || '').trim();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new Error('Username must be 3-20 letters, numbers, or underscores');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email (used only for password recovery)');
    }
    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }
    const existing = await db.collection('usernames').doc(username).get();
    if (existing.exists) throw new Error('That username is taken');

    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: username });
    await db.collection('usernames').doc(username).set({ uid: cred.user.uid, email });
    await db.collection('users').doc(cred.user.uid).set({
      username, email, bestScore: 0, updatedAt: Date.now(),
    });
    currentUser = cred.user;
    return username;
  }

  async function login(username, password) {
    username = normalize(username);
    const doc = await db.collection('usernames').doc(username).get();
    if (!doc.exists) throw new Error('No account with that username');
    const cred = await auth.signInWithEmailAndPassword(doc.data().email, password);
    currentUser = cred.user;
    return username;
  }

  async function resetPassword(username) {
    username = normalize(username);
    if (!username) throw new Error('Enter your username first, then tap "Forgot password?"');
    const doc = await db.collection('usernames').doc(username).get();
    if (!doc.exists) throw new Error('No account with that username');
    await auth.sendPasswordResetEmail(doc.data().email);
  }

  function logout() {
    return auth ? auth.signOut() : Promise.resolve();
  }

  async function getBestScore() {
    if (!currentUser || !db) return null;
    const doc = await db.collection('users').doc(currentUser.uid).get();
    return doc.exists ? (doc.data().bestScore || 0) : 0;
  }

  async function syncBestScore(score, cityNameAr) {
    if (!currentUser || !db) return;
    try {
      await db.collection('users').doc(currentUser.uid).set(
        { bestScore: score, updatedAt: Date.now() },
        { merge: true }
      );
      // Separate, publicly-readable doc (username + score + city, no email) so
      // the leaderboard can list other players without exposing anyone's
      // private users/{uid} doc.
      await db.collection('leaderboard').doc(currentUser.uid).set(
        { username: currentUser.displayName, bestScore: score, city: cityNameAr || null, updatedAt: Date.now() },
        { merge: true }
      );
    } catch (e) {
      // Offline or rules issue — best score still lives in localStorage as a fallback.
    }
  }

  async function getLeaderboard(limit) {
    if (!db) return [];
    const snap = await db.collection('leaderboard')
      .orderBy('bestScore', 'desc')
      .limit(limit || 20)
      .get();
    return snap.docs.map(doc => doc.data());
  }

  // Cheap rank lookup that doesn't require pulling the whole collection:
  // Firestore's count() aggregation is a single read no matter how many
  // documents match, so "how many players beat this score" stays cheap
  // even as the leaderboard grows.
  async function getMyRank(score) {
    if (!db || score == null) return null;
    try {
      const snap = await db.collection('leaderboard')
        .where('bestScore', '>', score)
        .count()
        .get();
      return snap.data().count + 1;
    } catch (e) {
      return null;
    }
  }

  window.CamelAuth = {
    isAvailable: () => configured,
    ready: (cb) => { if (ready) cb(currentUser); else readyCallbacks.push(cb); },
    isLoggedIn: () => !!currentUser,
    currentUsername: () => (currentUser && currentUser.displayName) || null,
    signup,
    login,
    logout,
    resetPassword,
    getBestScore,
    syncBestScore,
    getLeaderboard,
    getMyRank,
  };
})();
