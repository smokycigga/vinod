const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();
const crypto = require('crypto');
const auth = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'raghav098';

// Helper to generate API key
function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required.' });
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/\W/.test(password)) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long, contain an uppercase letter, a lowercase letter, a number, and a special character.' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Email already registered.' });

    // Bootstrap access on a fresh DB: first account becomes super admin.
    const userCount = await User.countDocuments();
    const isFirstUser = userCount === 0;

    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = generateApiKey();
    const user = new User({
      email,
      password: hashedPassword,
      apiKey,
      role: isFirstUser ? 'superadmin' : 'staff'
    });
    await user.save();
    res.status(201).json({
      message: isFirstUser
        ? 'User registered as super admin.'
        : 'User registered.',
      apiKey
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    console.log('Login attempt:', req.body.email);
    const { email, password } = req.body;

    if (!email || !password) {
      console.log('Missing email or password');
      return res.status(400).json({ message: 'Email and password required.' });
    }

    console.log('Finding user:', email);
    let user = await User.findOne({ email });

    if (!user) {
      const userCount = await User.countDocuments();

      if (userCount === 0) {
        const apiKey = generateApiKey();
        user = new User({
          email,
          password,
          apiKey,
          role: 'superadmin'
        });
        await user.save();
        console.log('Bootstrapped first superadmin via login:', email);
      } else {
        console.log('User not found:', email);
        return res.status(400).json({ message: 'Invalid credentials.' });
      }
    }

    console.log('User found:', user.email, 'Active:', user.isActive, 'Role:', user.role);

    if (!user.isActive) {
      console.log('User inactive:', email);
      return res.status(403).json({ message: 'Account is inactive. Please contact administrator.' });
    }

    console.log('Checking password...');
    let isMatch = false;
    if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'))) {
        isMatch = await bcrypt.compare(password, user.password);
    } else {
        isMatch = (user.password === password);
        if (isMatch) {
            user.password = await bcrypt.hash(password, 10);
            await user.save();
            console.log('Upgraded user password to bcrypt hash for:', email);
        }
    }

    if (!isMatch) {
      console.log('Password mismatch for:', email);
      return res.status(400).json({ message: 'Invalid credentials.' });
    }

    // Fresh DB fallback: if no super admin exists yet, promote the first
    // successfully authenticated active user.
    const superAdminExists = await User.exists({ role: 'superadmin' });
    if (!superAdminExists && user.role !== 'superadmin') {
      user.role = 'superadmin';
      await user.save();
      console.log('Auto-promoted first login user to superadmin:', email);
    }

    console.log('Password correct, updating last login...');
    // Update last login without validation
    await User.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date() } }
    );

    console.log('Generating token...');
    const token = jwt.sign({
      userId: user._id,
      role: user.role
    }, JWT_SECRET, { expiresIn: '7d' });

    console.log('Login successful for:', email);
    res.json({
      token,
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        permissions: user.permissions
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ message: 'Server error.', error: err.message });
  }
});

// Get current API key
router.get('/api-key', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ apiKey: user.apiKey });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// Regenerate API key
router.post('/api-key/regenerate', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const newApiKey = generateApiKey();
    user.apiKey = newApiKey;
    await user.save();

    res.json({
      message: 'API key regenerated successfully.',
      apiKey: newApiKey
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// Forgot password - generate reset token
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists
      return res.json({ message: 'If the email exists, a reset link has been sent.' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour from now
    await user.save();

    // In production, send email with reset link
    // const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${resetToken}`;
    // await sendEmail(user.email, 'Password Reset', `Click here to reset: ${resetUrl}`);

    res.json({
      message: 'Password reset link sent to your email.',
      // For development only - remove in production
      resetToken
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Reset password using token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword) || !/\W/.test(newPassword)) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long, contain an uppercase letter, a lowercase letter, a number, and a special character.' });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    // Update password
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password reset successful. Please login with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Change password (authenticated user)
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }

    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword) || !/\W/.test(newPassword)) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long, contain an uppercase letter, a lowercase letter, a number, and a special character.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify current password
    let isMatch = false;
    if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'))) {
        isMatch = await bcrypt.compare(currentPassword, user.password);
    } else {
        isMatch = (user.password === currentPassword);
    }

    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Get current user profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password -resetPasswordToken -resetPasswordExpires -apiKey')
      .populate('createdBy', 'username email fullName');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Update user profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { fullName, username } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (fullName) user.fullName = fullName;
    if (username) {
      // Check if username already exists
      const existing = await User.findOne({ username, _id: { $ne: user._id } });
      if (existing) {
        return res.status(400).json({ message: 'Username already taken' });
      }
      user.username = username;
    }

    await user.save();

    res.json({
      message: 'Profile updated successfully',
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName
      }
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router; 