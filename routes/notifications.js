const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');
const { canAccessModule } = require('../utils/accessControl');

// All routes require authentication
router.use(auth);

// Notification types that reveal invoice activity. Hidden from users who have
// no access to the invoices module, so historic notifications cannot leak
// invoice numbers or approval state to them.
const INVOICE_NOTIFICATION_TYPES = ['invoice_created', 'invoice_approved', 'invoice_rejected'];

// Merge the invoice-notification exclusion into a notification query when the
// user cannot access invoices.
function scopeToVisibleTypes(user, query) {
    if (canAccessModule(user, 'invoices')) return query;
    return { ...query, type: { $nin: INVOICE_NOTIFICATION_TYPES } };
}

// Get user's notifications (unread first, then recent read)
router.get('/', async (req, res) => {
    try {
        const { limit = 50, unreadOnly = false } = req.query;

        let query = { recipient: req.user._id };

        if (unreadOnly === 'true') {
            query.read = false;
        }

        query = scopeToVisibleTypes(req.user, query);

        const notifications = await Notification.find(query)
            .populate('sender', 'fullName email')
            .populate('lead', 'companyName contactPerson')
            .populate('task', 'action dueDate')
            .populate('invoice', 'invoiceNumber approvalStatus customerSnapshot.name')
            .sort({ read: 1, createdAt: -1 }) // Unread first, then by date
            .limit(parseInt(limit));

        res.json(notifications);
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Error fetching notifications', error: error.message });
    }
});

// Get unread notification count
router.get('/count', async (req, res) => {
    try {
        const count = await Notification.countDocuments(scopeToVisibleTypes(req.user, {
            recipient: req.user._id,
            read: false
        }));

        res.json({ count });
    } catch (error) {
        console.error('Error counting notifications:', error);
        res.status(500).json({ message: 'Error counting notifications', error: error.message });
    }
});

// Mark notification as read
router.put('/:id/read', async (req, res) => {
    try {
        const notification = await Notification.findOne(scopeToVisibleTypes(req.user, {
            _id: req.params.id,
            recipient: req.user._id
        }));
        
        if (!notification) {
            return res.status(404).json({ message: 'Notification not found' });
        }
        
        notification.read = true;
        notification.readAt = new Date();
        await notification.save();
        
        res.json({ message: 'Notification marked as read', notification });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ message: 'Error updating notification', error: error.message });
    }
});

// Mark all notifications as read
router.put('/read-all', async (req, res) => {
    try {
        const result = await Notification.updateMany(
            { recipient: req.user._id, read: false },
            { $set: { read: true, readAt: new Date() } }
        );
        
        res.json({ 
            message: 'All notifications marked as read', 
            modifiedCount: result.modifiedCount 
        });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ message: 'Error updating notifications', error: error.message });
    }
});

// Delete a notification
router.delete('/:id', async (req, res) => {
    try {
        const notification = await Notification.findOneAndDelete({
            _id: req.params.id,
            recipient: req.user._id
        });
        
        if (!notification) {
            return res.status(404).json({ message: 'Notification not found' });
        }
        
        res.json({ message: 'Notification deleted successfully' });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ message: 'Error deleting notification', error: error.message });
    }
});

module.exports = router;
