/**
 * Central access-control helpers.
 *
 * Most guards in this codebase short-circuit on `role === 'superadmin'` before
 * ever reading `user.permissions`. That makes the role an all-or-nothing switch
 * and silently ignores the per-user `permissionOverrides` mechanism in
 * models/User.js.
 *
 * These helpers close that gap: they honour an EXPLICIT denial in the merged
 * permissions object even for a superadmin, while leaving the historic role
 * bypass intact everywhere no such denial exists. That keeps existing
 * superadmins (Vinod, Komal, ...) behaving exactly as before, and lets us grant
 * someone full Super Admin powers minus specific capabilities.
 */

// Values that mean "denied" for both boolean and scoped ('all'|'none') perms.
function isDenied(value) {
    return value === false || value === 'none';
}

function getModulePerms(user, module) {
    return user && user.permissions ? user.permissions[module] : undefined;
}

/**
 * Is `action` on `module` denied by an EXPLICIT per-user override?
 *
 * We deliberately read `permissionOverrides` rather than the merged
 * `permissions` here. The merged object cannot distinguish a deliberate
 * per-user denial from a role default — e.g. superadmin's `leads.delete` is
 * 'none' by default (models/User.js) even though routes/leads.js has always
 * let superadmins delete leads. Keying off the override keeps that historic
 * behaviour intact for existing superadmins while making a targeted
 * restriction stick.
 */
function isExplicitlyDenied(user, module, action) {
    const overrides = user && user.permissionOverrides;
    if (!overrides || typeof overrides !== 'object') return false;
    const moduleOverride = overrides[module];
    if (!moduleOverride || typeof moduleOverride !== 'object') return false;
    return isDenied(moduleOverride[action]);
}

/**
 * Can `user` delete records in `module` (e.g. 'leads', 'tasks', 'invoices')?
 *
 * An explicit per-user denial always wins. Otherwise superadmin keeps its
 * historic bypass, and anything else falls back to the permission value.
 */
function canDelete(user, module) {
    if (!user) return false;

    if (isExplicitlyDenied(user, module, 'delete')) return false;

    if (user.role === 'superadmin') return true;

    const perms = getModulePerms(user, module);
    return Boolean(perms && perms.delete !== undefined && !isDenied(perms.delete));
}

/**
 * Can `user` sign invoices? Signing happens inside POST /api/invoices/:id/approve,
 * which writes the `isSigned: true` PDF, so approve === sign. Rejecting carries
 * the same authority and is gated on this too.
 */
function canSignInvoices(user) {
    if (!user) return false;
    if (user.role !== 'superadmin') return false;

    if (isExplicitlyDenied(user, 'invoices', 'approve')) return false;

    return true;
}

/**
 * True when a superadmin carries any explicit capability denial. Such a user
 * must not be able to lift their own restrictions or mint an unrestricted
 * superadmin to act on their behalf.
 */
function isRestrictedSuperAdmin(user) {
    if (!user || user.role !== 'superadmin') return false;

    if (isExplicitlyDenied(user, 'invoices', 'approve')) return true;

    return ['leads', 'tasks', 'users', 'invoices', 'pipelines'].some(
        (module) => isExplicitlyDenied(user, module, 'delete')
    );
}

/**
 * Express guard: refuse delete requests for `module`. Mount BEFORE the route's
 * own role logic so it cannot be bypassed.
 */
function denyDelete(module) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        if (!canDelete(req.user, module)) {
            return res.status(403).json({
                message: `Access denied. You do not have permission to delete ${module}.`
            });
        }
        next();
    };
}

module.exports = {
    canDelete,
    canSignInvoices,
    isRestrictedSuperAdmin,
    denyDelete
};
