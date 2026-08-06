// One-off: promote Tanvi to Super Admin with two carve-outs — she has no access
// to the invoices module at all, and she may not delete anything. Everything
// else is full Super Admin.
//
// Uses the per-user permissionOverrides mechanism (models/User.js), which the
// pre('save') hook applies ON TOP of the role defaults. The route guards in
// utils/accessControl.js honour these explicit denials even for a superadmin.
//
// Idempotent — safe to re-run. Usage: node scripts/promoteTanviRestrictedSuperAdmin.js
const mongoose = require('mongoose');
require('dotenv').config();
const dns = require('dns');
const User = require('../models/User');

const TARGET_EMAIL = 'tanvi@kenmccoy.in';

async function run() {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/crm_sales';
        if (mongoUri.startsWith('mongodb+srv://')) {
            dns.setServers(['8.8.8.8', '1.1.1.1']);
        }
        await mongoose.connect(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('Connected to MongoDB');

        const user = await User.findOne({ email: TARGET_EMAIL });
        if (!user) {
            console.error(`User not found: ${TARGET_EMAIL}`);
            process.exit(1);
        }

        console.log(`Found ${user.fullName} (${user.email}) — current role: ${user.role}`);

        user.role = 'superadmin';

        // Merge so we don't wipe existing overrides (she already has leads.create).
        const overrides = user.permissionOverrides && typeof user.permissionOverrides === 'object'
            ? { ...user.permissionOverrides }
            : {};

        // No invoice access whatsoever — the module is gated router-wide on
        // `access`, so this alone blocks list, read, PDF, create and edit. The
        // finer-grained flags stay false so nothing re-opens if `access` is
        // ever restored.
        overrides.invoices = {
            ...(overrides.invoices || {}),
            access: false,
            create: false,
            edit: false,
            approve: false,
            delete: false
        };

        // No deletes anywhere. Adds and edits are untouched.
        overrides.leads = { ...(overrides.leads || {}), delete: 'none' };
        overrides.tasks = { ...(overrides.tasks || {}), delete: 'none' };
        overrides.users = { ...(overrides.users || {}), delete: 'none' };
        overrides.pipelines = { ...(overrides.pipelines || {}), delete: false };

        user.permissionOverrides = overrides;
        user.markModified('permissionOverrides');

        await user.save(); // pre-save hook applies superadmin defaults, then merges overrides

        const refreshed = await User.findOne({ email: TARGET_EMAIL })
            .select('fullName email role permissionOverrides permissions');

        console.log('\n--- Result ---');
        console.log('role                :', refreshed.role);
        console.log('invoices.access     :', refreshed.permissions?.invoices?.access, '(must be false)');
        console.log('invoices.create     :', refreshed.permissions?.invoices?.create, '(must be false)');
        console.log('invoices.edit       :', refreshed.permissions?.invoices?.edit, '(must be false)');
        console.log('invoices.approve    :', refreshed.permissions?.invoices?.approve, '(must be false)');
        console.log('invoices.delete     :', refreshed.permissions?.invoices?.delete, '(must be false)');
        console.log('leads.create        :', refreshed.permissions?.leads?.create, '(preserved)');
        console.log('leads.edit          :', refreshed.permissions?.leads?.edit);
        console.log('leads.delete        :', refreshed.permissions?.leads?.delete, '(must be none)');
        console.log('tasks.delete        :', refreshed.permissions?.tasks?.delete, '(must be none)');
        console.log('users.create        :', refreshed.permissions?.users?.create);
        console.log('users.edit          :', refreshed.permissions?.users?.edit);
        console.log('users.delete        :', refreshed.permissions?.users?.delete, '(must be none)');
        console.log('pipelines.delete    :', refreshed.permissions?.pipelines?.delete, '(must be false)');
        console.log('settings.edit       :', refreshed.permissions?.settings?.edit);
        console.log('analytics.view      :', refreshed.permissions?.analytics?.view);

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

run();
