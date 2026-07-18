const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, sparse: true, trim: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  fullName: { type: String, trim: true },
  phone: { type: String, trim: true },
  department: { type: String, trim: true },
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'manager', 'staff', 'client'],
    default: 'staff'
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  teamMembers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  permissions: {
    leads: {
      view: { type: String, enum: ['all', 'department', 'team', 'assigned', 'none'], default: 'assigned' },
      create: { type: Boolean, default: true },
      edit: { type: String, enum: ['all', 'department', 'team', 'assigned', 'none'], default: 'assigned' },
      delete: { type: String, enum: ['all', 'department', 'team', 'assigned', 'none'], default: 'none' },
      export: { type: Boolean, default: false },
      assign: { type: Boolean, default: false }
    },
    pipelines: {
      view: { type: Boolean, default: true },
      edit: { type: Boolean, default: false }
    },
    tasks: {
      view: { type: String, enum: ['all', 'department', 'team', 'assigned', 'none'], default: 'assigned' },
      create: { type: Boolean, default: true },
      edit: { type: String, enum: ['all', 'department', 'team', 'assigned', 'none'], default: 'assigned' },
      delete: { type: String, enum: ['all', 'department', 'team', 'assigned', 'none'], default: 'none' }
    },
    users: {
      view: { type: String, enum: ['all', 'department', 'team', 'none'], default: 'none' },
      create: { type: String, enum: ['admin', 'manager', 'staff', 'none'], default: 'none' },
      edit: { type: String, enum: ['all', 'department', 'team', 'none'], default: 'none' },
      delete: { type: String, enum: ['all', 'department', 'team', 'none'], default: 'none' }
    },
    analytics: {
      view: { type: String, enum: ['all', 'department', 'team', 'own', 'none'], default: 'own' }
    },
    settings: {
      view: { type: Boolean, default: false },
      edit: { type: Boolean, default: false }
    },
    communications: {
      send: { type: Boolean, default: true },
      view: { type: String, enum: ['all', 'department', 'team', 'own', 'none'], default: 'own' }
    }
  },
  isActive: { type: Boolean, default: true },
  // Per-user permission overrides applied ON TOP of the role-based defaults.
  // Mirrors the `permissions` shape, e.g. { leads: { create: true } }. Only the
  // keys present here are overridden; everything else falls back to the role.
  permissionOverrides: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  apiKey: { type: String, required: true, unique: true },

  emailConfig: {
    outlookEmail: { type: String, trim: true },
    outlookPassword: { type: String },
    isConfigured: { type: Boolean, default: false },
    lastVerified: { type: Date }
  },
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date },
  updatedAt: { type: Date, default: Date.now }
});

// Set default permissions based on role
UserSchema.pre('save', function (next) {
  // Normalize role to lowercase
  if (this.role) {
    this.role = this.role.toLowerCase();
  }

  // Always set permissions based on role (not just when modified)
  // This ensures old documents with invalid permission structures get corrected
  if (this.role) {
    if (this.role === 'superadmin') {
      // Super Admin - Full access to everything, can create Admins (NO lead delete)
      this.permissions = {
        leads: { view: 'all', create: true, edit: 'all', delete: 'none', export: true, assign: true },
        pipelines: { view: true, edit: true },
        tasks: { view: 'all', create: true, edit: 'all', delete: 'all' },
        users: { view: 'all', create: 'admin', edit: 'all', delete: 'all' },
        analytics: { view: 'all' },
        settings: { view: true, edit: true },
        communications: { send: true, view: 'all' }
      };
    } else if (this.role === 'admin') {
      // Admin - Department-level access, can create Managers, NO delete permission for leads
      this.permissions = {
        leads: { view: 'department', create: true, edit: 'department', delete: 'none', export: true, assign: true },
        pipelines: { view: true, edit: true },
        tasks: { view: 'department', create: true, edit: 'department', delete: 'department' },
        users: { view: 'department', create: 'manager', edit: 'department', delete: 'department' },
        analytics: { view: 'department' },
        settings: { view: true, edit: true },
        communications: { send: true, view: 'department' }
      };
    } else if (this.role === 'manager') {
      // Manager - Team-level access, NO user management
      this.permissions = {
        leads: { view: 'team', create: true, edit: 'team', delete: 'none', export: true, assign: true },
        pipelines: { view: true, edit: false },
        tasks: { view: 'team', create: true, edit: 'team', delete: 'team' },
        users: { view: 'team', create: 'none', edit: 'none', delete: 'none' },
        analytics: { view: 'team' },
        settings: { view: false, edit: false },
        communications: { send: true, view: 'team' }
      };
    } else if (this.role === 'client') {
      // Client - Can only view their own limited dashboard/agreements
      this.permissions = {
        leads: { view: 'none', create: false, edit: 'none', delete: 'none', export: false, assign: false },
        pipelines: { view: false, edit: false },
        tasks: { view: 'none', create: false, edit: 'none', delete: 'none' },
        users: { view: 'none', create: 'none', edit: 'none', delete: 'none' },
        analytics: { view: 'none' },
        settings: { view: false, edit: false },
        communications: { send: false, view: 'none' }
      };
    } else {
      // Staff - Can only see and update assigned leads (status & remarks only)
      this.permissions = {
        leads: { view: 'assigned', create: false, edit: 'assigned', delete: 'none', export: false, assign: false },
        pipelines: { view: true, edit: false },
        tasks: { view: 'assigned', create: true, edit: 'assigned', delete: 'none' },
        users: { view: 'none', create: 'none', edit: 'none', delete: 'none' },
        analytics: { view: 'own' },
        settings: { view: false, edit: false },
        communications: { send: true, view: 'own' }
      };
    }
  }

  // Apply per-user permission overrides ON TOP of the role-based defaults.
  // Only the keys present in permissionOverrides are changed; the rest keep the
  // role default. This lets us grant one-off rights (e.g. a specific staff member
  // who may create leads) without changing their role or affecting other users.
  if (this.permissionOverrides && typeof this.permissionOverrides === 'object') {
    for (const moduleKey of Object.keys(this.permissionOverrides)) {
      const moduleOverride = this.permissionOverrides[moduleKey];
      if (!moduleOverride || typeof moduleOverride !== 'object') continue;
      if (!this.permissions[moduleKey]) this.permissions[moduleKey] = {};
      for (const actionKey of Object.keys(moduleOverride)) {
        this.permissions[moduleKey][actionKey] = moduleOverride[actionKey];
      }
    }
    this.markModified('permissions');
  }

  this.updatedAt = new Date();
  next();
});


module.exports = mongoose.model('User', UserSchema); 