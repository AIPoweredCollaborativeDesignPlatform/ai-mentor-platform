import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/**
 * Study roles. The administrator is a fixed bootstrap account; observers (advisors, assistants) are
 * added by email from the admin page and get the custom claim role: 'observer'. Observers can enter
 * any study room invisibly (read-only), see every whiteboard, upload status and replays, but cannot
 * edit profiles, Drive or consent settings. The list lives in roles/current, which has no rule and
 * is therefore server-only. firestore.rules reads the claim (isObserver()).
 */

export const ADMIN_EMAIL = 'bb900114@gmail.com'; // matches isAdmin() in firestore.rules

const rolesRef = () => getFirestore().doc('roles/current');
const normEmail = email => String(email || '').trim().toLowerCase();

export const isAdminToken = token => token?.email === ADMIN_EMAIL && token?.email_verified === true;
export const isObserverToken = token => isAdminToken(token) || token?.role === 'observer';

export async function listObservers() {
  const observers = (await rolesRef().get()).data()?.observers || {};
  return Object.values(observers).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

async function applyClaim(email, role) {
  try {
    const user = await getAuth().getUserByEmail(email);
    const { role: _old, ...rest } = user.customClaims || {};
    await getAuth().setCustomUserClaims(user.uid, role ? { ...rest, role } : rest);
    return true;
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return false; // applied on their first sign-in (syncRole)
    throw err;
  }
}

/** Adds or removes an observer. Accounts that never signed in get the claim on their first sign-in. */
export async function setObserver(email, add, addedBy) {
  const key = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) throw new Error('Invalid email');
  if (key === ADMIN_EMAIL) throw new Error('The administrator already has every permission');
  const field = `observers.${key.replace(/\./g, '_')}`;
  if (add) await rolesRef().set({ observers: { [key.replace(/\./g, '_')]: { email: key, addedAt: Date.now(), addedBy } } }, { merge: true });
  else await rolesRef().update({ [field]: FieldValue.delete() }).catch(() => {});
  const applied = await applyClaim(key, add ? 'observer' : null);
  return { email: key, applied };
}

/** Called by the browser after sign-in: brings the caller's claim in line with the list. */
export async function syncRole(uid, token) {
  if (isAdminToken(token)) return { role: 'admin', changed: false };
  const email = normEmail(token?.email);
  const listed = Boolean(email && token?.email_verified && (await listObservers()).some(o => o.email === email));
  const has = token?.role === 'observer';
  if (listed !== has) {
    const user = await getAuth().getUser(uid);
    const { role: _old, ...rest } = user.customClaims || {};
    await getAuth().setCustomUserClaims(uid, listed ? { ...rest, role: 'observer' } : rest);
  }
  return { role: listed ? 'observer' : null, changed: listed !== has };
}

/**
 * Signing in with Google replaces the anonymous account with a new uid. Rooms the anonymous account
 * hosted move to the new uid; the anonymous ID token (taken before the sign-in popup) proves the
 * caller owned it, since browsers can no longer change hostUid themselves.
 */
export async function claimAnonymousRooms(newUid, anonIdToken) {
  const decoded = await getAuth().verifyIdToken(String(anonIdToken || ''));
  if (decoded.firebase?.sign_in_provider !== 'anonymous') throw new Error('Not an anonymous account');
  const oldUid = decoded.uid;
  if (oldUid === newUid) return { moved: 0 };
  const db = getFirestore();
  const rooms = await db.collection('rooms').where('hostUid', '==', oldUid).get();
  for (const room of rooms.docs) {
    const oldPart = room.ref.collection('participants').doc(oldUid);
    const snap = await oldPart.get();
    const batch = db.batch();
    batch.update(room.ref, { hostUid: newUid });
    batch.set(room.ref.collection('participants').doc(newUid), { ...(snap.data() || { status: 'approved', isHost: true, joinedAt: Date.now() }), uid: newUid });
    if (snap.exists) batch.delete(oldPart);
    await batch.commit();
  }
  return { moved: rooms.size, roomIds: rooms.docs.map(d => d.id) };
}
