import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, collection, onSnapshot, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
const FIREBASE_CONFIG = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            || "",
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        || "",
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         || "",
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID|| "",
  appId:             import.meta.env.VITE_FIREBASE_APP_ID             || "",
};
export const CLOUD_ENABLED = !!FIREBASE_CONFIG.projectId;
let _app, _db, _auth;
if (CLOUD_ENABLED) {
  _app  = getApps().length > 0 ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
  _db   = getFirestore(_app);
  _auth = getAuth(_app);
}
export const db = _db || null;
export const auth = _auth || null;
const LOCAL_UID_KEY = "mm_user_id";
export function getLocalUserId() { try { return localStorage.getItem(LOCAL_UID_KEY); } catch { return null; } }
export async function ensureSignedIn() {
  if (!CLOUD_ENABLED || !_auth) return null;
  const current = _auth.currentUser;
  if (current) { try { localStorage.setItem(LOCAL_UID_KEY, current.uid); } catch {} return current.uid; }
  try {
    const cred = await signInAnonymously(_auth);
    try { localStorage.setItem(LOCAL_UID_KEY, cred.user.uid); } catch {}
    return cred.user.uid;
  } catch (e) { console.warn("[Firebase] signInAnonymously failed:", e.message); return null; }
}
export function watchAuth(cb) {
  if (!CLOUD_ENABLED || !_auth) return () => {};
  return onAuthStateChanged(_auth, user => {
    if (user) { try { localStorage.setItem(LOCAL_UID_KEY, user.uid); } catch {} cb(user.uid); } else { cb(null); }
  });
}
function portfolioRef(userId, portfolioId) { return doc(_db, "users", userId, "portfolios", portfolioId); }
function portfoliosCol(userId) { return collection(_db, "users", userId, "portfolios"); }
export function subscribePortfolios(userId, cb) {
  if (!CLOUD_ENABLED || !_db || !userId) return () => {};
  return onSnapshot(portfoliosCol(userId), snap => {
    const p = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    p.sort((a, b) => (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
    cb(p);
  }, err => console.warn("[Firebase] subscribePortfolios:", err.message));
}
export async function savePortfolioCloud(userId, portfolio) {
  if (!CLOUD_ENABLED || !_db || !userId) return;
  try { const { id, ...data } = portfolio; await setDoc(portfolioRef(userId, id), { ...data, updatedAt: serverTimestamp() }, { merge: true }); }
  catch (e) { console.warn("[Firebase] save:", e.message); }
}
export async function deletePortfolioCloud(userId, portfolioId) {
  if (!CLOUD_ENABLED || !_db || !userId) return;
  try { await deleteDoc(portfolioRef(userId, portfolioId)); }
  catch (e) { console.warn("[Firebase] delete:", e.message); }
}
