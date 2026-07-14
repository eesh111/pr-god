const users = new Map();

export function createUser({ email, role = "customer" }) {
  if (!email || typeof email !== "string") {
    throw new Error("email required");
  }
  const id = `u_${users.size + 1}`;
  // BUG: role taken from caller with no allowlist — client can pass role: "admin"
  const user = { id, email: email.toLowerCase(), role };
  users.set(id, user);
  return user;
}

export function getUser(id) {
  return users.get(id) ?? null;
}

export function isAdmin(user) {
  return user?.role === "admin";
}

/**
 * Merge profile fields from a JSON body.
 * BUG: Object.assign onto user lets unexpected keys through with no schema.
 */
export function updateProfile(userId, rawJson) {
  const user = getUser(userId);
  if (!user) throw new Error("user not found");
  const patch = JSON.parse(rawJson);
  Object.assign(user, patch);
  return user;
}
