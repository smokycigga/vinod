// One-off: grant a specific staff user permission to create leads via a
// per-user permission override (keeps their 'staff' role and all other perms).
// Usage: node scripts/grantTanviLeadCreate.js
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

        // Merge the override so we don't wipe any existing overrides.
        const overrides = user.permissionOverrides && typeof user.permissionOverrides === 'object'
            ? { ...user.permissionOverrides }
            : {};
        overrides.leads = { ...(overrides.leads || {}), create: true };
        user.permissionOverrides = overrides;
        user.markModified('permissionOverrides');

        await user.save(); // pre-save hook re-applies role perms + merges overrides

        const refreshed = await User.findOne({ email: TARGET_EMAIL })
            .select('fullName email role permissionOverrides permissions.leads');
        console.log('Updated user:', JSON.stringify(refreshed, null, 2));
        console.log('leads.create =', refreshed.permissions?.leads?.create);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

run();
