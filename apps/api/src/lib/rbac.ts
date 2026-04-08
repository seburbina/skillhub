/**
 * RBAC role matrix — Phase 0 §0.6.
 *
 * This file defines the enterprise role model BEFORE any code uses it.
 * Getting the roles and permissions named now — during calm Phase 0 PR
 * review — means the discussion about "can a Publisher delete their own
 * skill" happens without deadline pressure.
 *
 * Nothing in the Phase 0 codebase imports this file. That is intentional.
 * When Phase 2 ships tenants, the new `tenant_members.role` column will
 * reference `TenantRole`, and mutation endpoints will gate on
 * `hasPermission(member.role, 'skill.publish')` etc.
 *
 * When adding a role: update `TENANT_ROLES`, `ROLE_PERMISSIONS`, and the
 * documentation in §15.1 of `docs/enterprise-scoping.md`.
 *
 * When adding a permission: update `PERMISSIONS`, `ROLE_PERMISSIONS` for
 * every role that should have it, and add it to the "stake in the ground"
 * comment at the bottom of this file.
 */

/** Every role a tenant member can hold. Ordered roughly by privilege. */
export const TENANT_ROLES = [
  "owner",
  "admin",
  "publisher",
  "consumer",
  "viewer",
  "billing",
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

/** Every permission the system checks. Namespaced `<subject>.<verb>`. */
export const PERMISSIONS = [
  // Tenant management
  "tenant.read",
  "tenant.update",
  "tenant.delete",

  // Member management
  "members.read",
  "members.invite",
  "members.remove",
  "members.change_role",

  // Skills
  "skill.read",
  "skill.publish",
  "skill.edit_own",
  "skill.edit_any",
  "skill.delete_own",
  "skill.delete_any",
  "skill.yank",

  // Installation / invocation
  "skill.install",
  "skill.invoke",

  // Moderation
  "moderation.read",
  "moderation.resolve",

  // Audit log
  "audit.read",
  "audit.export",

  // Billing / Stripe
  "billing.read",
  "billing.manage",

  // Allowlist (Phase 0 §0.8 hook)
  "allowlist.read",
  "allowlist.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permission matrix. Each role owns a Set of permissions.
 * `owner` has every permission unconditionally.
 */
export const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),

  admin: new Set<Permission>([
    "tenant.read",
    "tenant.update",
    "members.read",
    "members.invite",
    "members.remove",
    "members.change_role",
    "skill.read",
    "skill.publish",
    "skill.edit_own",
    "skill.edit_any",
    "skill.delete_own",
    "skill.delete_any",
    "skill.yank",
    "skill.install",
    "skill.invoke",
    "moderation.read",
    "moderation.resolve",
    "audit.read",
    "audit.export",
    "allowlist.read",
    "allowlist.manage",
  ]),

  publisher: new Set<Permission>([
    "tenant.read",
    "members.read",
    "skill.read",
    "skill.publish",
    "skill.edit_own",
    "skill.delete_own",
    "skill.install",
    "skill.invoke",
    "allowlist.read",
  ]),

  consumer: new Set<Permission>([
    "tenant.read",
    "members.read",
    "skill.read",
    "skill.install",
    "skill.invoke",
    "allowlist.read",
  ]),

  viewer: new Set<Permission>([
    "tenant.read",
    "members.read",
    "skill.read",
    "moderation.read",
    "audit.read",
    "allowlist.read",
  ]),

  billing: new Set<Permission>([
    "tenant.read",
    "billing.read",
    "billing.manage",
  ]),
};

/** Returns true iff `role` is allowed to perform `permission`. */
export function hasPermission(
  role: TenantRole,
  permission: Permission,
): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Assert a role has a permission or throw. Use from route handlers in
 * Phase 2 to gate mutations:
 *
 *     requirePermission(member.role, "skill.publish");
 */
export function requirePermission(
  role: TenantRole,
  permission: Permission,
): void {
  if (!hasPermission(role, permission)) {
    throw new Error(
      `Role '${role}' does not have permission '${permission}'`,
    );
  }
}

/**
 * STAKE IN THE GROUND — design decisions baked in here:
 *
 * 1. `owner` is the only role that can delete the tenant.
 * 2. `admin` has every `skill.*` permission including `edit_any` — this
 *    lets them curate the tenant's skill catalog even when they're not
 *    the original author.
 * 3. `publisher` can only edit/delete skills they authored
 *    (`edit_own`, `delete_own`). They can't curate other publishers'
 *    skills. Upgrade path: promote to `admin`.
 * 4. `consumer` is read + install + invoke. This is the "regular
 *    employee" role — they USE skills, they don't publish them.
 * 5. `viewer` is a read-only role for auditors / security reviewers.
 *    No install, no invoke, no mutations. Explicit `audit.read`.
 * 6. `billing` is intentionally narrow — finance team members who need
 *    access to invoices but should not see the agent data. No `skill.*`
 *    permissions at all.
 * 7. `members.invite` is an admin-tier permission. Publishers cannot
 *    self-serve-add new team members.
 * 8. `skill.yank` (emergency version pull) is admin+owner only.
 *
 * These are decisions, not guesses. Change deliberately.
 */
