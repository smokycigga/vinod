const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User');

async function checkUsers() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/crm_sales', {
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
