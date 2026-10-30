import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/**
 * Study roles. The primary administrator is a fixed bootstrap account. It can add more administrators
 * (custom claim role: 'admin', same permissions except managing administrators). Observers (advisors,
 * assistants) are added by email from the admin page and get role: 'observer': they can enter any study
 * room invisibly (read-only), see every whiteboard, upload status and replays, but cannot edit profiles,
 * Drive or consent settings. Both lists live in roles/current, which has no rule and is therefore
 * server-only. firestore.rules reads the claim (isAdmin(), isObserver()).
 */

export const ADMIN_EMAIL = 'bb900114@gmail.com'; // matches isAdmin() in firestore.rules

const rolesRef = () => getFirestore().doc('roles/current');
const normEmail = email => String(email || '').trim().toLowerCase();
const mapKey = email => email.replace(/\./g, '_');

export const isPrimaryAdminToken = token => token?.email === ADMIN_EMAIL && token?.email_verified === true;
export const isAdminToken = token => isPrimaryAdminToken(token) || (token?.role === 'admin' && token?.email_verified === true);
export const isObserverToken = token => isAdminToken(token) || token?.role === 'observer';

const sortByAdded = map => Object.values(map || {}).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
export async function listObservers() {
  return sortByAdded((await rolesRef().get()).data()?.observers);
}
export async function listAdmins() {
  return sortByAdded((await rolesRef().get()).data()?.admins);
}

/** The role an email should carry: administrator wins over observer. */
async function listedRole(email) {
  const data = (await rolesRef().get()).data() || {};
  if (data.admins?.[mapKey(email)]) return 'admin';
  if (data.observers?.[mapKey(email)]) return 'observer';
  return null;
}

async function applyClaim(email, role, signOut = false) {
  try {
    const user = await getAuth().getUserByEmail(email);
    const { role: _old, ...rest } = user.customClaims || {};
    await getAuth().setCustomUserClaims(user.uid, role ? { ...rest, role } : rest);
    // A removed administrator's current token would keep working up to an hour: end their sessions now
    if (signOut) await getAuth().revokeRefreshTokens(user.uid);
    return true;
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return false; // applied on their first sign-in (syncRole)
    throw err;
  }
}

/**
 * Adds or removes an email in one of the role lists ('observers' or 'admins') and updates the account's
 * claim to whatever role it still has. Accounts that never signed in get the claim on their first sign-in.
 */
async function setListed(list, email, add, addedBy) {
  const key = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) throw new Error('Invalid email');
  if (key === ADMIN_EMAIL) throw new Error('The primary administrator already has every permission');
  if (add) await rolesRef().set({ [list]: { [mapKey(key)]: { email: key, addedAt: Date.now(), addedBy } } }, { merge: true });
  else await rolesRef().update({ [`${list}.${mapKey(key)}`]: FieldValue.delete() }).catch(() => {});
  const applied = await applyClaim(key, await listedRole(key), !add && list === 'admins');
  return { email: key, applied };
}

export const setObserver = (email, add, addedBy) => setListed('observers', email, add, addedBy);
export const setAdmin = (email, add, addedBy) => setListed('admins', email, add, addedBy);

/** Called by the browser after sign-in: brings the caller's claim in line with the lists. */
export async function syncRole(uid, token) {
  if (isPrimaryAdminToken(token)) return { role: 'admin', changed: false };
  const email = normEmail(token?.email);
  const role = email && token?.email_verified ? await listedRole(email) : null;
  const has = token?.role || null;
  if (role !== has) {
    const user = await getAuth().getUser(uid);
    const { role: _old, ...rest } = user.customClaims || {};
    await getAuth().setCustomUserClaims(uid, role ? { ...rest, role } : rest);
  }
  return { role, changed: role !== has };
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
