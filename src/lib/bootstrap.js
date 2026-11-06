// Company bootstrap: the "first day" of a tenant, in one transaction.
//
// Lives here rather than in auth.routes.js because two callers now need it and
// they must agree exactly: `POST /api/auth/register` (self-service signup) and
// `node src/cli.js create-company` (the operator-side path used by the installers
// when signup is closed). Anything that writes a company but not its first
// branch and owner would leave an unopenable install, so the shape is kept in a
// single place.

import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { id } from './helpers.js';

/**
 * Create a company with its first branch (`Cabang Utama`) and its `super_admin`
 * owner. Returns the created user row, because callers immediately need it to
 * sign a token or report the new id.
 *
 * The caller is responsible for the uniqueness checks (`users.email`,
 * `companies.name`): this function assumes it is allowed to run.
 */
export function bootstrapCompany({ companyName, name, email, password }) {
  const companyId = id();
  const userId = id();
  const branchId = id();
  const hash = bcrypt.hashSync(password, 10);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO companies (id, name, email) VALUES (?, ?, ?)').run(companyId, companyName, email);
    db.prepare(
      `INSERT INTO branches (id, company_id, name, address, opening_hours)
       VALUES (?, ?, ?, ?, ?)`
    ).run(branchId, companyId, 'Cabang Utama', null, '08:00-22:00');
    db.prepare(
      `INSERT INTO users (id, company_id, branch_id, name, email, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, 'super_admin')`
    ).run(userId, companyId, branchId, name, email, hash);
  });
  tx();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}
