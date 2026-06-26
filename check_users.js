const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User');

const dns = require('dns');

async function checkUsers() {
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
        const count = await User.countDocuments();
        console.log('User count:', count);
        const users = await User.find().select('fullName email role isActive department managerId');
        console.log('Users:', JSON.stringify(users, null, 2));
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkUsers();
