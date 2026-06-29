const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const auth = require('../middleware/auth');
const Invoice = require('../models/Invoice');
const InvoiceCustomer = require('../models/InvoiceCustomer');
const InvoiceCompany = require('../models/InvoiceCompany');
const InvoiceCounter = require('../models/InvoiceCounter');
const Settings = require('../models/Settings');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Lead = require('../models/Lead');
const { getFinancialYear } = require('../utils/invoiceNumbering');
const { generateInvoiceWord } = require('../utils/wordGenerator');
const { isLeadClient, leadClientQuery, normalizeLeadClientFields } = require('../utils/leadClient');
const moment = require('moment-timezone');

// All routes require authentication
router.use(auth);

// ─── Admin-only guard ────────────────────────────────────────────────────────
function adminOnly(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
}

function superadminOnly(req, res, next) {
    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ message: 'Only Super Admin can access this resource.' });
    }
    next();
}

function canAccessInvoice(req, invoice) {
    if (!invoice) return false;
    if (req.user.role === 'superadmin') return true;
    if (req.user.role === 'admin') return true;
    return invoice.createdBy?.toString() === req.user._id.toString();
}

function getSignedPdfDir() {
    return process.env.VERCEL
        ? path.join(os.tmpdir(), 'uploads', 'signed')
        : path.join(__dirname, '..', 'uploads', 'signed');
}

function getSignedPdfPath(signedPdfUrl) {
    if (!signedPdfUrl) return null;
    return path.join(__dirname, '..', signedPdfUrl);
}

const KOMAL_EMAIL = 'komal@kenmccoy.in';
const VINOD_EMAIL = 'vinod@kenmccoy.in';

function isUserEmail(user, email) {
    return String(user?.email || '').toLowerCase() === email;
}

async function getVinodApprover() {
    return User.findOne({ email: VINOD_EMAIL, role: 'superadmin', isActive: true }).select('_id email fullName username');
}

async function getInvoiceApprovalAssignment(user) {
    if (isUserEmail(user, KOMAL_EMAIL)) {
        const vinod = await getVinodApprover();
        if (vinod) {
            return { approvalStatus: 'pending', assignedApprover: vinod._id };
        }
    }

    if (user.role === 'superadmin') {
        return { approvalStatus: 'approved', assignedApprover: null, approvedBy: user._id, approvedAt: new Date() };
    }

    return { approvalStatus: 'pending', assignedApprover: null };
}

function canApproveAssignedInvoice(user, invoice) {
    if (user.role !== 'superadmin') return false;
    if (!invoice.assignedApprover) return true;
    return invoice.assignedApprover.toString() === user._id.toString();
}

function escapeCsv(value) {
    const text = value == null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
}

function invoiceToExportRow(invoice) {
    const creator = invoice.createdBy || {};
    return {
        'Invoice No': invoice.invoiceNumber || '',
        'Invoice Date': invoice.invoiceDate ? moment(invoice.invoiceDate).format('YYYY-MM-DD') : '',
        'Customer': invoice.customerSnapshot?.name || invoice.customer?.name || '',
        'Customer Email': invoice.customerSnapshot?.email || '',
        'Candidates': (invoice.candidates || []).map(c => c.name).filter(Boolean).join('; '),
        'Chargeable Amount': invoice.chargeableAmount || 0,
        'Net Payable': invoice.netPayable || 0,
        'Receivable Amount': invoice.receivableAmount || 0,
        'Payment Status': invoice.paymentStatus || '',
        'Approval Status': invoice.approvalStatus || '',
        'Due Date': invoice.dueDate ? moment(invoice.dueDate).format('YYYY-MM-DD') : '',
        'Submitted By': creator.fullName || creator.username || creator.email || '',
        'Created At': invoice.createdAt ? moment(invoice.createdAt).format('YYYY-MM-DD') : ''
    };
}

// ════════════════════════════════════════════════════════════
//   BILLING COMPANY ROUTES
// ════════════════════════════════════════════════════════════

// Helper: get company snapshot object
function companySnapshot(c) {
    return {
        name: c.name,
        tagline: c.tagline,
        logo: c.logo,
        sacCode: c.sacCode,
        panNumber: c.panNumber,
        accountName: c.accountName,
        bankName: c.bankName,
        branchName: c.branchName,
        caNumber: c.caNumber,
        ifscCode: c.ifscCode,
        gstn: c.gstn
    };
}

// GET /api/invoices/billing-companies  — list all
router.get('/billing-companies', async (req, res) => {
    try {
        const companies = await InvoiceCompany.find().sort({ isPrimary: -1, name: 1 });
        res.json(companies);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/invoices/billing-companies  — create
router.post('/billing-companies', superadminOnly, async (req, res) => {
    try {
        const { name, tagline, sacCode, panNumber, accountName, bankName, branchName, caNumber, ifscCode, gstn, isPrimary } = req.body;
        if (isPrimary) {
            await InvoiceCompany.updateMany({}, { isPrimary: false });
        }
        const company = new InvoiceCompany({ name, tagline, sacCode, panNumber, accountName, bankName, branchName, caNumber, ifscCode, gstn, isPrimary: !!isPrimary });
        await company.save();
        res.status(201).json(company);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PUT /api/invoices/billing-companies/:id  — update
router.put('/billing-companies/:id', superadminOnly, async (req, res) => {
    try {
        const { name, tagline, sacCode, panNumber, accountName, bankName, branchName, caNumber, ifscCode, gstn, isPrimary } = req.body;
        if (isPrimary) {
            await InvoiceCompany.updateMany({ _id: { $ne: req.params.id } }, { isPrimary: false });
        }
        const company = await InvoiceCompany.findByIdAndUpdate(
            req.params.id,
            { name, tagline, sacCode, panNumber, accountName, bankName, branchName, caNumber, ifscCode, gstn, isPrimary: !!isPrimary, updatedAt: Date.now() },
            { new: true, runValidators: true }
        );
        if (!company) return res.status(404).json({ message: 'Company not found.' });
        res.json(company);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// DELETE /api/invoices/billing-companies/:id  — delete
router.delete('/billing-companies/:id', superadminOnly, async (req, res) => {
    try {
        const inUse = await Invoice.exists({ billingCompany: req.params.id });
        if (inUse) {
            return res.status(400).json({ message: 'Cannot delete — invoices exist for this company.' });
        }
        const company = await InvoiceCompany.findByIdAndDelete(req.params.id);
        if (!company) return res.status(404).json({ message: 'Company not found.' });
        res.json({ message: 'Company deleted.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//   INVOICE CUSTOMER ROUTES
// ════════════════════════════════════════════════════════════

// GET /api/invoices/customers  — list all customers
router.get('/customers', async (req, res) => {
    try {
        const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
        const customers = await InvoiceCustomer.find(includeArchived ? {} : { archivedAt: { $exists: false } }).lean();

        // Fetch CRM clients from Leads. A lead becomes a client only after a
        // client status plus an agreement/contract attachment.
        const clients = await Lead.find(leadClientQuery()).lean();

        const existingNames = new Set(customers.filter(c => !c.archivedAt).map(c => c.name.toLowerCase()));

        const mappedClients = clients
            .filter(client => {
                const name = client.companyName || client.contactPerson || '';
                return name && !existingNames.has(name.toLowerCase());
            })
            .map(client => {
                normalizeLeadClientFields(client);
                return {
                    _id: client._id,
                    customerId: client.customerCode || 'CLIENT',
                    name: client.companyName || client.contactPerson,
                    address: client.address || '',
                    contactNo: client.mobile || '',
                    email: client.email || '',
                    gstNo: client.gstNo || '',
                    vendorCode: 'NA',
                    isLeadClient: true,
                    source: 'lead'
                };
            });

        const combined = [...customers, ...mappedClients].sort((a, b) => a.name.localeCompare(b.name));

        res.json(combined);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/invoices/customers  — create customer
router.post('/customers', superadminOnly, async (req, res) => {
    try {
        const { customerId, name, address, contactNo, email, gstNo, vendorCode } = req.body;
        const customer = new InvoiceCustomer({ customerId, name, address, contactNo, email, gstNo, vendorCode });
        await customer.save();
        res.status(201).json(customer);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Customer ID already exists.' });
        }
        res.status(500).json({ message: err.message });
    }
});

// PUT /api/invoices/customers/:id  — update customer
router.put('/customers/:id', superadminOnly, async (req, res) => {
    try {
        const { customerId, name, address, contactNo, email, gstNo, vendorCode } = req.body;
        const customer = await InvoiceCustomer.findByIdAndUpdate(
            req.params.id,
            { customerId, name, address, contactNo, email, gstNo, vendorCode, updatedAt: Date.now() },
            { new: true, runValidators: true }
        );
        if (!customer) return res.status(404).json({ message: 'Customer not found.' });
        res.json(customer);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// DELETE /api/invoices/customers/:id  — delete customer
router.delete('/customers/:id', superadminOnly, async (req, res) => {
    try {
        const customer = await InvoiceCustomer.findByIdAndUpdate(
            req.params.id,
            { archivedAt: new Date(), archivedBy: req.user._id, updatedAt: Date.now() },
            { new: true }
        );
        if (!customer) return res.status(404).json({ message: 'Customer not found.' });
        res.json({ message: 'Customer archived.', customer });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/customers/:id/restore', superadminOnly, async (req, res) => {
    try {
        const customer = await InvoiceCustomer.findByIdAndUpdate(
            req.params.id,
            { $unset: { archivedAt: '', archivedBy: '' }, updatedAt: Date.now() },
            { new: true }
        );
        if (!customer) return res.status(404).json({ message: 'Customer not found.' });
        res.json({ message: 'Customer restored.', customer });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//   INVOICE ROUTES
// ════════════════════════════════════════════════════════════

// GET /api/invoices  — list all invoices
router.get('/', async (req, res) => {
    try {
        const { status, customerId, from, to, search, approvalStatus } = req.query;
        let filter = { archivedAt: { $exists: false } };

        // Only superadmin can see all invoices; everyone else sees only their own.
        if (req.user.role !== 'superadmin') {
            filter.createdBy = req.user._id;
        }

        if (status) filter.paymentStatus = status;
        if (approvalStatus) {
            filter.approvalStatus = approvalStatus;
            if (approvalStatus === 'pending' && req.user.role === 'superadmin') {
                filter.$or = [
                    { assignedApprover: req.user._id },
                    { assignedApprover: { $exists: false } },
                    { assignedApprover: null }
                ];
            }
        }
        if (customerId) filter.customer = customerId;
        if (from || to) {
            filter.invoiceDate = {};
            if (from) filter.invoiceDate.$gte = new Date(from);
            if (to) filter.invoiceDate.$lte = new Date(to);
        }
        if (search) {
            filter.$or = [
                { invoiceNumber: { $regex: search, $options: 'i' } },
                { 'customerSnapshot.name': { $regex: search, $options: 'i' } },
                { 'candidates.name': { $regex: search, $options: 'i' } }
            ];
        }

        const invoices = await Invoice.find(filter)
            .populate('customer', 'customerId name')
            .populate('createdBy', 'fullName username email')
            .populate('assignedApprover', 'fullName username email')
            .populate('approvedBy', 'fullName username email')
            .sort({ invoiceDate: -1 });

        // Auto-mark overdue invoices
        const today = new Date();
        const updates = [];
        for (const inv of invoices) {
            if (inv.paymentStatus === 'unpaid' && inv.dueDate && today > inv.dueDate) {
                inv.paymentStatus = 'overdue';
                updates.push(Invoice.findByIdAndUpdate(inv._id, { paymentStatus: 'overdue' }));
            }
        }
        await Promise.all(updates);

        if (req.query.format === 'csv') {
            const rows = invoices.map(invoiceToExportRow);
            const headers = Object.keys(invoiceToExportRow({}));
            const csv = [
                headers.map(escapeCsv).join(','),
                ...rows.map(row => headers.map(header => escapeCsv(row[header])).join(','))
            ].join('\n');

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="invoices-export-${new Date().toISOString().split('T')[0]}.csv"`);
            return res.send(csv);
        }

        res.json(invoices);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/stats  — summary stats
router.get('/stats', async (req, res) => {
    try {
        const today = new Date();
        const filter = req.user.role === 'superadmin'
            ? { archivedAt: { $exists: false } }
            : { createdBy: req.user._id, archivedAt: { $exists: false } };

        // Auto-update overdue (for relevant invoices)
        await Invoice.updateMany(
            { ...filter, paymentStatus: 'unpaid', dueDate: { $lt: today } },
            { paymentStatus: 'overdue' }
        );

        const [total, paid, unpaid, overdue, totalsRes] = await Promise.all([
            Invoice.countDocuments(filter),
            Invoice.countDocuments({ ...filter, paymentStatus: 'paid' }),
            Invoice.countDocuments({ ...filter, paymentStatus: { $in: ['unpaid', 'partial'] } }),
            Invoice.countDocuments({ ...filter, paymentStatus: 'overdue' }),
            Invoice.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: null,
                        totalValue: { $sum: '$netPayable' },
                        totalOutstanding: {
                            $sum: { $cond: [{ $ne: ['$paymentStatus', 'paid'] }, '$netPayable', 0] }
                        },
                        totalChargeableAmount: { $sum: { $ifNull: ['$chargeableAmount', 0] } },
                        receivableFromClient: {
                            $sum: {
                                $add: [
                                    { $multiply: [{ $ifNull: ['$chargeableAmount', 0] }, 0.9] },
                                    { $ifNull: ['$totalGst', 0] }
                                ]
                            }
                        }
                    }
                }
            ])
        ]);
        const totals = totalsRes[0] || {};

        res.json({
            total,
            paid,
            unpaid,
            overdue,
            totalValue: totals.totalValue || 0,
            totalOutstanding: totals.totalOutstanding || 0,
            totalChargeableAmount: totals.totalChargeableAmount || 0,
            receivableFromClient: totals.receivableFromClient || 0
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//   INVOICE NUMBERING MANAGEMENT
// ════════════════════════════════════════════════════════════

// GET /api/invoices/numbering/next  — preview next invoice number (no increment)
router.get('/numbering/next', async (req, res) => {
    try {
        const dateStr = (req.query.date || '').toString().trim();
        const baseDate = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();

        if (Number.isNaN(baseDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date value.' });
        }

        const prefix = 'KM';
        const fy = getFinancialYear(baseDate);
        const counter = await InvoiceCounter.findOne({ financialYear: fy, prefix });
        const sequence = (counter?.currentSequence || 0) + 1;
        const invoiceNumber = `${prefix}/${fy}/${String(sequence).padStart(3, '0')}`;

        res.json({ invoiceNumber, financialYear: fy, prefix, sequence });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/numbering/series  — get current invoice series info
router.get('/numbering/series', superadminOnly, async (req, res) => {
    try {
        const counters = await InvoiceCounter.find().sort({ financialYear: -1 });
        res.json(counters);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PUT /api/invoices/numbering/series/:fy  — update sequence for a financial year
router.put('/numbering/series/:fy', superadminOnly, async (req, res) => {
    try {
        const { fy } = req.params;
        const { sequence, prefix } = req.body;

        if (sequence < 0) {
            return res.status(400).json({ message: 'Sequence must be 0 or greater.' });
        }

        const counter = await InvoiceCounter.setSequence(fy, sequence, prefix || 'KM');
        res.json(counter);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// DELETE /api/invoices/numbering/series/:fy  — delete sequence config for a financial year
router.delete('/numbering/series/:fy', superadminOnly, async (req, res) => {
    try {
        const { fy } = req.params;
        const prefix = (req.query.prefix || 'KM').toString().trim() || 'KM';

        // Prevent deleting active series that already has invoices.
        const pattern = new RegExp(`^${prefix}/${fy}/`);
        const inUse = await Invoice.exists({ invoiceNumber: pattern });
        if (inUse) {
            return res.status(400).json({ message: `Cannot delete ${prefix}/${fy} series because invoices already exist for this year.` });
        }

        const deleted = await InvoiceCounter.findOneAndDelete({ financialYear: fy, prefix });
        if (!deleted) {
            return res.status(404).json({ message: `Series ${prefix}/${fy} not found.` });
        }

        res.json({ message: `Series ${prefix}/${fy} deleted successfully.` });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/invoices/numbering/reset  — reset sequence for a financial year
router.post('/numbering/reset', superadminOnly, async (req, res) => {
    try {
        const { fy, prefix } = req.body;

        if (!fy) {
            return res.status(400).json({ message: 'Financial year is required.' });
        }

        const counter = await InvoiceCounter.resetSequence(fy, prefix || 'KM');
        res.json({ message: `Invoice sequence reset for FY ${fy}`, counter });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/client/agreements  — list all agreements for a client
router.get('/client/agreements', async (req, res) => {
    if (req.user.role !== 'client') {
        return res.status(403).json({ message: 'Access denied.' });
    }
    try {
        const invoices = await Invoice.find({ 'customerSnapshot.email': req.user.email })
            .select('invoiceNumber invoiceDate customerSnapshot attachments');

        const agreements = [];
        invoices.forEach(inv => {
            if (inv.attachments && inv.attachments.length > 0) {
                inv.attachments.forEach(att => {
                    if (att.type === 'customer-agreement' || (att.fileName && att.fileName.toLowerCase().includes('agreement'))) {
                        agreements.push({
                            invoiceId: inv._id,
                            invoiceNumber: inv.invoiceNumber,
                            invoiceDate: inv.invoiceDate,
                            attachment: att
                        });
                    }
                });
            }
        });
        res.json(agreements);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/:id  — single invoice
router.get('/:id', async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id)
            .populate('customer')
            .populate('createdBy', 'fullName username email')
            .populate('assignedApprover', 'fullName username email')
            .populate('approvedBy', 'fullName username email');
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        // Only superadmin can view all invoices; everyone else can view only created invoices.
        if (req.user.role !== 'superadmin') {
            if (invoice.createdBy?._id?.toString() !== req.user._id.toString()) {
                return res.status(403).json({ message: 'Access denied.' });
            }
        }
        res.json(invoice);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/invoices  — create invoice (any authenticated user)
router.post('/', async (req, res) => {
    try {
        const {
            invoiceDate, customerId, billingCompanyId, deptCode, vendorCode, poId,
            serviceType, chargesFor, candidates, chargeableSalary, rate,
            paymentStatus, receivableAmount, tdsAmount, receivedDate, notes, dueDate
        } = req.body;

        // Fetch customer (Auto-create if it's a CRM Client / Lead)
        let customer = await InvoiceCustomer.findById(customerId);
        if (!customer) {
            const lead = await Lead.findById(customerId);
            if (!lead) return res.status(404).json({ message: 'Customer not found.' });
            if (!isLeadClient(lead)) {
                return res.status(400).json({ message: 'Lead must be converted to a client before invoicing.' });
            }
            normalizeLeadClientFields(lead);
            if (lead.isModified && lead.isModified()) await lead.save();

            // Check if an InvoiceCustomer with this name already exists
            customer = await InvoiceCustomer.findOne({ name: lead.companyName || lead.contactPerson });
            if (!customer) {
                const uniqueCode = lead.customerCode || ('LD-' + lead._id.toString().substring(18).toUpperCase());
                const existingByCode = await InvoiceCustomer.findOne({ customerId: uniqueCode });
                customer = new InvoiceCustomer({
                    customerId: existingByCode ? uniqueCode + '-' + Math.floor(Math.random() * 1000) : uniqueCode,
                    name: lead.companyName || lead.contactPerson || 'Unknown Client',
                    address: lead.address || '',
                    contactNo: lead.mobile || '',
                    email: lead.email || '',
                    gstNo: lead.gstNo || '',
                    vendorCode: 'NA'
                });
                await customer.save();
            }
        }

        // Fetch billing company (fall back to primary)
        let bCompany = billingCompanyId ? await InvoiceCompany.findById(billingCompanyId) : null;
        if (!bCompany) bCompany = await InvoiceCompany.findOne({ isPrimary: true });
        if (!bCompany) bCompany = await InvoiceCompany.findOne();

        // Determine invoice date (default to now)
        const finalInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();

        // Always auto-generate invoice number using KM/[FY]/[###] pattern.
        const fy = getFinancialYear(finalInvoiceDate);
        const finalInvoiceNumber = await InvoiceCounter.getNextInvoiceNumber(fy, 'KM');

        // Handle due date - keep it flexible and mandatory
        if (!dueDate) {
            return res.status(400).json({ message: 'Due date is required.' });
        }

        const approvalAssignment = await getInvoiceApprovalAssignment(req.user);

        const invoice = new Invoice({
            invoiceNumber: finalInvoiceNumber,
            invoiceDate: finalInvoiceDate,
            dueDate: new Date(dueDate),
            customer: customer._id,
            customerSnapshot: {
                customerId: customer.customerId,
                name: customer.name,
                address: customer.address,
                contactNo: customer.contactNo,
                email: customer.email,
                gstNo: customer.gstNo,
                vendorCode: customer.vendorCode
            },
            billingCompany: bCompany ? bCompany._id : undefined,
            billingCompanySnapshot: bCompany ? companySnapshot(bCompany) : undefined,
            deptCode: deptCode || 'NA',
            vendorCode: (vendorCode && vendorCode.trim()) ? vendorCode.trim() : 'NA',
            poId,
            serviceType: serviceType || 'sourcing',
            chargesFor: chargesFor || '',
            candidates: candidates || [],
            chargeableSalary: Number(chargeableSalary),
            rate: Number(rate),
            paymentStatus: paymentStatus || 'unpaid',
            receivableAmount: receivableAmount ? Number(receivableAmount) : 0,
            tdsAmount: tdsAmount ? Number(tdsAmount) : 0,
            receivedDate: receivedDate || null,
            notes,
            createdBy: req.user._id,
            approvalStatus: approvalAssignment.approvalStatus,
            assignedApprover: approvalAssignment.assignedApprover || null,
            approvedBy: approvalAssignment.approvedBy || null,
            approvedAt: approvalAssignment.approvedAt || null
        });

        await invoice.save();

        // Notify superadmins about invoices that need approval
        if (invoice.approvalStatus === 'pending') {
            const approvers = invoice.assignedApprover
                ? await User.find({ _id: invoice.assignedApprover }).select('_id')
                : await User.find({ role: 'superadmin' }).select('_id');
            const creatorName = req.user.fullName || req.user.username || req.user.email || 'A user';
            if (approvers.length > 0) {
                await Notification.insertMany(
                    approvers.map((admin) => ({
                        recipient: admin._id,
                        sender: req.user._id,
                        invoice: invoice._id,
                        type: 'invoice_created',
                        message: `Invoice ${invoice.invoiceNumber} was created by ${creatorName} and requires your approval.`
                    }))
                );
            }
        } else {
            // Auto-approved (superadmin created) — notify other superadmins
            const superadmins = await User.find({
                role: 'superadmin',
                _id: { $ne: req.user._id }
            }).select('_id');
            const creatorName = req.user.fullName || req.user.username || req.user.email || 'A user';
            if (superadmins.length > 0) {
                await Notification.insertMany(
                    superadmins.map((admin) => ({
                        recipient: admin._id,
                        sender: req.user._id,
                        invoice: invoice._id,
                        type: 'invoice_created',
                        message: `Invoice ${invoice.invoiceNumber} was created by ${creatorName} (auto-approved).`
                    }))
                );
            }
        }

        res.status(201).json(invoice);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Invoice number already exists.' });
        }
        res.status(500).json({ message: err.message });
    }
});

// PUT /api/invoices/:id  — update invoice
router.put('/:id', async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

        const isCreator = invoice.createdBy?.toString() === req.user._id.toString();
        const isAdmin = req.user.role === 'admin';
        const isSuperAdmin = req.user.role === 'superadmin';

        if (!isSuperAdmin && !isAdmin && !isCreator) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        // Managers and Staff can only edit if it's still pending and not locked
        if (!isSuperAdmin && invoice.approvalStatus !== 'pending') {
            return res.status(403).json({ message: 'Cannot edit an invoice that is already approved or rejected.' });
        }

        const {
            invoiceNumber, invoiceDate, customerId, billingCompanyId, deptCode, vendorCode, poId,
            serviceType, chargesFor, candidates, chargeableSalary, rate,
            paymentStatus, receivableAmount, tdsAmount, receivedDate, notes, dueDate
        } = req.body;

        // PERMISSION CHECK: Only Super User can edit if invoice is locked
        if (invoice.isLocked && req.user.role !== 'superadmin') {
            return res.status(403).json({
                message: 'Only Super User can edit locked invoices. Invoice number and date are permanently locked.'
            });
        }

        const changedFields = [];

        // LOCKED FIELDS: Invoice number and date cannot be changed
        if (invoiceNumber && invoiceNumber !== invoice.invoiceNumber) {
            return res.status(400).json({
                message: 'Invoice number is locked and cannot be changed once created.'
            });
        }
        if (invoiceDate && new Date(invoiceDate).toISOString().split('T')[0] !== new Date(invoice.invoiceDate).toISOString().split('T')[0]) {
            return res.status(400).json({
                message: 'Invoice date is locked and cannot be changed once created.'
            });
        }

        // EDITABLE FIELDS: Financial details and payment info only
        if (chargeableSalary !== undefined && invoice.chargeableSalary !== Number(chargeableSalary)) {
            invoice.chargeableSalary = Number(chargeableSalary);
            changedFields.push('chargeableSalary');
        }
        if (rate !== undefined && invoice.rate !== Number(rate)) {
            invoice.rate = Number(rate);
            changedFields.push('rate');
        }
        if (dueDate && invoice.dueDate.toString() !== new Date(dueDate).toString()) {
            invoice.dueDate = new Date(dueDate);
            changedFields.push('dueDate');
        }
        if (paymentStatus && invoice.paymentStatus !== paymentStatus) {
            invoice.paymentStatus = paymentStatus;
            changedFields.push('paymentStatus');
        }
        if (receivableAmount !== undefined && invoice.receivableAmount !== Number(receivableAmount)) {
            invoice.receivableAmount = Number(receivableAmount);
            changedFields.push('receivableAmount');
        }
        if (tdsAmount !== undefined && invoice.tdsAmount !== Number(tdsAmount)) {
            invoice.tdsAmount = Number(tdsAmount);
            changedFields.push('tdsAmount');
        }
        if (receivedDate !== undefined) {
            invoice.receivedDate = receivedDate || null;
            if (receivedDate) changedFields.push('receivedDate');
        }
        if (notes !== undefined && invoice.notes !== notes) {
            invoice.notes = notes;
            changedFields.push('notes');
        }
        if (deptCode !== undefined && invoice.deptCode !== deptCode) {
            invoice.deptCode = deptCode;
            changedFields.push('deptCode');
        }
        if (vendorCode !== undefined) {
            const finalVendorCode = vendorCode.trim() || 'NA';
            if (invoice.vendorCode !== finalVendorCode) {
                invoice.vendorCode = finalVendorCode;
                changedFields.push('vendorCode');
            }
        }
        if (poId !== undefined && invoice.poId !== poId) {
            invoice.poId = poId;
            changedFields.push('poId');
        }
        if (chargesFor !== undefined && invoice.chargesFor !== chargesFor) {
            invoice.chargesFor = chargesFor;
            changedFields.push('chargesFor');
        }
        if (candidates !== undefined) {
            // Convert to string to check if it actually changed
            if (JSON.stringify(invoice.candidates) !== JSON.stringify(candidates)) {
                invoice.candidates = candidates;
                changedFields.push('candidates');
            }
        }

        // Track edit history if changes were made
        if (changedFields.length > 0) {
            invoice.lastEditedBy = req.user._id;
            invoice.lastEditedAt = new Date();

            if (!invoice.editHistory) invoice.editHistory = [];
            invoice.editHistory.push({
                editedBy: req.user._id,
                editedAt: new Date(),
                changedFields: changedFields
            });

            // Clear cached signed PDF so next download regenerates with updated data
            if (invoice.signedPdfUrl) {
                const oldPdfPath = getSignedPdfPath(invoice.signedPdfUrl);
                try { if (fs.existsSync(oldPdfPath)) fs.unlinkSync(oldPdfPath); } catch (e) { /* ignore */ }
                invoice.signedPdfUrl = undefined;
            }
        }

        await invoice.save();
        res.json(invoice);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Invoice number already exists.' });
        }
        res.status(500).json({ message: err.message });
    }
});

// DELETE /api/invoices/:id  — delete invoice
router.delete('/:id', async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

        const isCreator = invoice.createdBy?.toString() === req.user._id.toString();
        const isSuperAdmin = req.user.role === 'superadmin';

        if (!isSuperAdmin && !isCreator) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        // Managers and Staff can only delete if it's still pending
        if (!isSuperAdmin && invoice.approvalStatus !== 'pending') {
            return res.status(403).json({ message: 'Cannot delete an invoice that is already processed.' });
        }

        invoice.archivedAt = new Date();
        invoice.archivedBy = req.user._id;
        await invoice.save();
        res.json({ message: 'Invoice archived.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PATCH /api/invoices/:id/payment  — record payment received
router.post('/:id/restore', adminOnly, async (req, res) => {
    try {
        const invoice = await Invoice.findByIdAndUpdate(
            req.params.id,
            { $unset: { archivedAt: '', archivedBy: '' }, updatedAt: Date.now() },
            { new: true }
        );
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        res.json({ message: 'Invoice restored.', invoice });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.patch('/:id/payment', async (req, res) => {
    try {
        const { amount, date, notes } = req.body;
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ message: 'Invalid payment amount.' });
        }

        // Initialize receivableAmount if it's 0 and netPayable is > 0 (assuming it was never set)
        if ((!invoice.receivableAmount || invoice.receivableAmount === 0) && invoice.netPayable > 0 && invoice.paymentStatus !== 'paid') {
            invoice.receivableAmount = invoice.netPayable;
        }

        invoice.receivableAmount = Math.max(0, invoice.receivableAmount - Number(amount));

        if (invoice.receivableAmount <= 0) {
            invoice.paymentStatus = 'paid';
        } else {
            invoice.paymentStatus = 'partial';
        }

        if (date) invoice.receivedDate = new Date(date);
        if (notes) {
            invoice.notes = (invoice.notes ? invoice.notes + '\n' : '') + `[Payment Received: ${fmtINR(amount)} on ${new Date(date || Date.now()).toLocaleDateString()}] ${notes}`;
        }

        // Add to edit history
        if (!invoice.editHistory) invoice.editHistory = [];
        invoice.editHistory.push({
            editedBy: req.user._id,
            editedAt: new Date(),
            changedFields: ['receivableAmount', 'paymentStatus']
        });

        await invoice.save();
        res.json(invoice);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Helper for route-level formatting if needed (though fmtINR is in utils/dashboard)
function fmtINR(n) {
    if (n == null || isNaN(n)) return '₹0.00';
    return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ════════════════════════════════════════════════════════════
//   INVOICE APPROVAL WORKFLOW
// ════════════════════════════════════════════════════════════

// POST /api/invoices/:id/approve  — approve an invoice (superadmin only)
router.post('/:id/approve', async (req, res) => {
    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ message: 'Only Super Admin can approve invoices.' });
    }
    try {
        const { note } = req.body;

        const existing = await Invoice.findById(req.params.id);
        if (!existing) return res.status(404).json({ message: 'Invoice not found.' });
        if (existing.approvalStatus !== 'pending') {
            return res.status(400).json({ message: 'Only pending invoices can be approved.' });
        }
        if (!canApproveAssignedInvoice(req.user, existing)) {
            return res.status(403).json({ message: 'This invoice is assigned to another Super Admin for approval.' });
        }

        const invoice = await Invoice.findByIdAndUpdate(
            req.params.id,
            {
                approvalStatus: 'approved',
                approvalNote: note || '',
                approvedBy: req.user._id,
                approvedAt: new Date(),
                assignedApprover: existing.assignedApprover || req.user._id
            },
            { new: true }
        ).populate('customer').populate('billingCompany');

        // Generate and save physical PDF
        const settings = await Settings.findOne({ user: req.user._id }).select('invoiceDefaults');
        const template = settings?.invoiceDefaults?.defaultTemplate || 'image1';
        const settingsSealImage = settings?.invoiceDefaults?.defaultSealUrl || null;

        const uploadsDir = getSignedPdfDir();
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const safeInvNum = invoice.invoiceNumber.replace(/\//g, '-');
        const filename = `Invoice-${safeInvNum}-SIGNED-${Date.now()}.pdf`;
        const filePath = path.join(uploadsDir, filename);
        const writeStream = fs.createWriteStream(filePath);

        await generateInvoicePDF(invoice, writeStream, { isSigned: true, template, settingsSealImage });

        if (!process.env.VERCEL) {
            invoice.signedPdfUrl = `/uploads/signed/${filename}`;
        }
        await invoice.save();

        if (invoice.createdBy) {
            await Notification.create({
                recipient: invoice.createdBy,
                sender: req.user._id,
                invoice: invoice._id,
                type: 'invoice_approved',
                message: `Your invoice ${invoice.invoiceNumber} has been approved.`
            });
        }


        res.json(invoice);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/invoices/:id/reject  — reject an invoice (superadmin only)
router.post('/:id/reject', async (req, res) => {
    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ message: 'Only Super Admin can reject invoices.' });
    }
    try {
        const { note } = req.body;

        const existing = await Invoice.findById(req.params.id);
        if (!existing) return res.status(404).json({ message: 'Invoice not found.' });
        if (existing.approvalStatus !== 'pending') {
            return res.status(400).json({ message: 'Only pending invoices can be rejected.' });
        }
        if (!canApproveAssignedInvoice(req.user, existing)) {
            return res.status(403).json({ message: 'This invoice is assigned to another Super Admin for approval.' });
        }

        const invoice = await Invoice.findByIdAndUpdate(
            req.params.id,
            {
                approvalStatus: 'rejected',
                approvalNote: note || ''
            },
            { new: true }
        );

        // Notify the invoice creator about the rejection
        if (invoice.createdBy) {
            const approverName = req.user.fullName || req.user.username || req.user.email || 'Super Admin';
            await Notification.create({
                recipient: invoice.createdBy,
                sender: req.user._id,
                invoice: invoice._id,
                type: 'invoice_rejected',
                message: `Your invoice ${invoice.invoiceNumber} was rejected by ${approverName}.${note ? ' Reason: ' + note : ''}`
            });
        }

        res.json(invoice);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//   PDF GENERATION
// ════════════════════════════════════════════════════════════

// GET /api/invoices/:id/pdf  — download regular PDF
router.get('/:id/pdf', async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id)
            .populate('customer')
            .populate('billingCompany');
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

        // Access check
        if (req.user.role === 'client') {
            if (invoice.customerSnapshot?.email !== req.user.email) {
                return res.status(403).json({ message: 'Access denied.' });
            }
        } else if (!canAccessInvoice(req, invoice)) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        // Serve cached signed PDF only if invoice hasn't been edited since it was generated
        if (!process.env.VERCEL && invoice.approvalStatus === 'approved' && invoice.signedPdfUrl) {
            const cachedIsStale = invoice.lastEditedAt && invoice.approvedAt && new Date(invoice.lastEditedAt) > new Date(invoice.approvedAt);
            if (!cachedIsStale) {
                const filePath = getSignedPdfPath(invoice.signedPdfUrl);
                if (fs.existsSync(filePath)) {
                    const safeNum = invoice.invoiceNumber.replace(/\//g, '-');
                    return res.download(filePath, `Invoice-${safeNum}-SIGNED.pdf`);
                }
            }
            // Stale or file missing — clear cached reference and regenerate below
            if (invoice.signedPdfUrl) {
                const oldPath = getSignedPdfPath(invoice.signedPdfUrl);
                try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (e) { /* ignore */ }
                invoice.signedPdfUrl = undefined;
            }
        }

        // No cached PDF — generate fresh
        // For approved invoices, use the approver's seal settings (not downloader's)
        const settingsUserId = (invoice.approvalStatus === 'approved' && invoice.approvedBy) ? invoice.approvedBy : req.user._id;
        const settings = await Settings.findOne({ user: settingsUserId }).select('invoiceDefaults');
        const template = settings?.invoiceDefaults?.defaultTemplate || 'image1';
        const settingsSealImage = settings?.invoiceDefaults?.defaultSealUrl || null;
        const pdfOptions = { template, settingsSealImage };

        // If approved, mark as signed and save the regenerated PDF for future caching
        if (invoice.approvalStatus === 'approved') {
            pdfOptions.isSigned = true;
            if (invoice.signatures && invoice.signatures.length > 0) {
                pdfOptions.signatureInfo = invoice.signatures[invoice.signatures.length - 1];
            }

            // Save regenerated PDF to disk for future downloads
            const uploadsDir = getSignedPdfDir();
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            const safeNum2 = invoice.invoiceNumber.replace(/\//g, '-');
            const filename = `Invoice-${safeNum2}-SIGNED-${Date.now()}.pdf`;
            const filePath = path.join(uploadsDir, filename);
            const writeStream = fs.createWriteStream(filePath);
            await generateInvoicePDF(invoice, writeStream, pdfOptions);
            if (!process.env.VERCEL) {
                invoice.signedPdfUrl = `/uploads/signed/${filename}`;
            }
            await invoice.save();
            return res.download(filePath, `Invoice-${safeNum2}-SIGNED.pdf`);
        }

        await generateInvoicePDF(invoice, res, pdfOptions);
    } catch (err) {
        console.error('PDF generation error:', err);
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/:id/pdf/signed  — download PDF with digital signature indicator
router.get('/:id/pdf/signed', superadminOnly, async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id)
            .populate('customer')
            .populate('billingCompany');
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        if (!canAccessInvoice(req, invoice)) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        if (!invoice.signatures || invoice.signatures.length === 0) {
            return res.status(400).json({ message: 'Invoice has not been signed yet.' });
        }

        const latestSignature = invoice.signatures[invoice.signatures.length - 1];
        const settings = await Settings.findOne({ user: req.user._id }).select('invoiceDefaults');
        const template = settings?.invoiceDefaults?.defaultTemplate || 'image1';
        const settingsSealImage = settings?.invoiceDefaults?.defaultSealUrl || null;
        await generateInvoicePDF(invoice, res, {
            isSigned: true,
            signatureInfo: latestSignature,
            template,
            settingsSealImage
        });
    } catch (err) {
        console.error('Signed PDF generation error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//   WORD & SIGNATURE EXPORT
// ════════════════════════════════════════════════════════════

// Multer config for attachment uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../uploads/invoice-attachments');
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadAttachment = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed. Please upload PDF or Word documents.'));
        }
    }
});

// POST /api/invoices/:id/attachments  — upload attachment
router.post('/:id/attachments', superadminOnly, uploadAttachment.single('file'), async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        if (!req.file) return res.status(400).json({ message: 'No file provided.' });

        const { type } = req.body;
        const allowedTypes = ['customer-agreement', 'offer-letter', 'other'];
        const attachmentType = allowedTypes.includes(type) ? type : 'other';

        if (!invoice.attachments) invoice.attachments = [];
        invoice.attachments.push({
            type: attachmentType,
            fileName: req.file.originalname,
            fileUrl: `/uploads/invoice-attachments/${req.file.filename}`,
            uploadedAt: new Date(),
            uploadedBy: req.user._id
        });
        await invoice.save();
        res.status(201).json({
            message: 'Attachment uploaded successfully.',
            attachment: invoice.attachments[invoice.attachments.length - 1]
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/:id/attachments  — list attachments
router.get('/:id/attachments', superadminOnly, async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        res.json(invoice.attachments || []);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/:id/attachment/download  — download attachment securely
router.get('/:id/attachment/download', async (req, res) => {
    try {
        const { fileName } = req.query;
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

        if (req.user.role === 'client') {
            if (invoice.customerSnapshot?.email !== req.user.email) {
                return res.status(403).json({ message: 'Access denied.' });
            }
        } else if (!canAccessInvoice(req, invoice)) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        const attachment = invoice.attachments.find(a => a.fileName === fileName);
        if (!attachment || !attachment.fileUrl) {
            return res.status(404).json({ message: 'Attachment not found.' });
        }

        const filePath = path.join(__dirname, '..', attachment.fileUrl);
        res.download(filePath);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// DELETE /api/invoices/:id/attachments/:index  — delete attachment
router.delete('/:id/attachments/:index', superadminOnly, async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        const index = parseInt(req.params.index);
        if (isNaN(index) || index < 0 || index >= (invoice.attachments || []).length) {
            return res.status(400).json({ message: 'Invalid attachment index.' });
        }
        invoice.attachments.splice(index, 1);
        await invoice.save();
        res.json({ message: 'Attachment deleted successfully.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/invoices/:id/word  — download invoice as Word document
router.get('/:id/word', superadminOnly, async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id).populate('customer');
        if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
        const buffer = await generateInvoiceWord(invoice, invoice.billingCompanySnapshot);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="Invoice-${invoice.invoiceNumber}.docx"`);
        res.send(buffer);
    } catch (err) {
        console.error('Word generation error:', err);
        res.status(500).json({ message: err.message });
    }
});
// ── SHARED PDF GENERATOR ──────────────────────────────────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PRECISION) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PRECISION) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PREMIUM) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PREMIUM) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PREMIUM) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 REFINED) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 REFINED) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PIXEL PERFECT) ───────────
// ── SHARED PDF GENERATOR (PORTRAIT A4 PERFECTED) ───────────
async function generateInvoicePDF(invoice, res, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const snap = invoice.customerSnapshot || invoice.customer || {};
            const co = invoice.billingCompany || invoice.billingCompanySnapshot || {};
            const coName = co.name || process.env.COMPANY_NAME || 'Ken McCoy Consulting';
            const coSac = co.sacCode || '998516';
            const KMC_LOGO = require('path').join(__dirname, '..', 'public', 'images', 'logo-kmc.jpg');
            const fs2 = require('fs');

            const txt = (v) => (v == null ? '' : String(v));
            const fmt = (n) => {
                const value = Number(String(n || 0).replace(/,/g, ''));
                return Number.isFinite(value) ? value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
            };
            const fmtDate = (d) => {
                if (!d) return '';
                const dt = new Date(d);
                if (Number.isNaN(dt.getTime())) return '';
                return require('moment-timezone')(dt).tz("Asia/Kolkata").format('DD-MM-YYYY');
            };

            const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0, autoFirstPage: true });
            const downloadVersion = Date.now();
            const safeInvNo = invoice.invoiceNumber.replace(/\//g, '-');
            const filename = options.isSigned ? `Invoice-${safeInvNo}-SIGNED-${downloadVersion}.pdf` : `Invoice-${safeInvNo}-${downloadVersion}.pdf`;

            if (typeof res.setHeader === 'function') {
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            }
            doc.pipe(res);

            // Margin setup for professional, slightly-asymmetric layout (Left > Right)
            const snapLine = (n) => Math.round(n) + 0.5;
            const W = 595, H = 842, MT = 30, ML = 45, MR = 560, CW = MR - ML;
            // Shared service-table column geometry (also used by top metadata split for perfect alignment).
            const baseSw = [30, 232, 110, 53, 105];
            const baseTotal = baseSw.reduce((a, b) => a + b, 0);
            const scale = CW / baseTotal;
            const sw = [
                Math.round(baseSw[0] * scale),
                Math.round(baseSw[1] * scale),
                Math.round(baseSw[2] * scale),
                Math.round(baseSw[3] * scale),
                0
            ];
            sw[4] = CW - (sw[0] + sw[1] + sw[2] + sw[3]);
            const sx = [ML, ML + sw[0], ML + sw[0] + sw[1], ML + sw[0] + sw[1] + sw[2], ML + sw[0] + sw[1] + sw[2] + sw[3], MR];

            const BLUE = '#2b5a8e', ORANGE = '#E65100', BLK = '#000000', GRY = '#555555', YEL = '#f6e05e', SAFFRON = '#FF9933';
            let y = MT;
            const T = (s, x, ty, o) => { doc.text(s, x, ty, Object.assign({ lineBreak: false }, o || {})); };

            // ──────── HEADER (aligned to margins) ────────
            const hH = 95;
            doc.rect(snapLine(ML), snapLine(MT), CW, hH).fill(BLUE);
            doc.rect(snapLine(ML), snapLine(MT), CW, hH).strokeColor(BLK).lineWidth(0.5).stroke();
            doc.fontSize(21).fillColor('white').font('Helvetica-Bold'); T('Ken McCoy Consulting', ML + 10, MT + 18);
            doc.fontSize(8.5).fillColor('white').font('Helvetica');
            T('B201, Hind Saurashtra Ind.Est, Marol,', ML + 10, MT + 45);
            T('Andheri - Kurla Road, Andheri (E), Mumbai 400059', ML + 10, MT + 58);
            T('Tel: 91 22 42959123, Mail: info@kenmccoy.in, Web: www.kenmccoy.in', ML + 10, MT + 71);

            // Align metadata split so INVOICE NO block starts exactly above Chargeable Salary.
            const cW = sw[0] + sw[1], mW = CW - cW;
            const mX = ML + cW, mLW = sw[2];
            doc.fontSize(12).fillColor(SAFFRON).font('Helvetica-Bold');
            T('TAX INVOICE', mX + mLW, MT + hH - 22, { width: mW - mLW, align: 'center' });
            y = MT + hH;

            // ──────── CUSTOMER + METADATA (flush to header) ────────
            const sY = y, cX = ML;
            const mRH = 18, mTH = 135; // Reduced height as per annotation


            // Draw metadata grid with a single dotted style and snapped coordinates
            // so all rows have identical texture.
            doc.strokeColor(BLK).lineWidth(0.5).lineCap('butt');
            doc.moveTo(snapLine(ML), snapLine(sY)).lineTo(snapLine(MR), snapLine(sY)).stroke();
            doc.moveTo(snapLine(ML), snapLine(sY + mTH)).lineTo(snapLine(MR), snapLine(sY + mTH)).stroke();
            doc.moveTo(snapLine(mX), snapLine(sY)).lineTo(snapLine(mX), snapLine(sY + mTH)).stroke();

            doc.rect(cX, sY, cW, mRH).fill('white');
            doc.fontSize(8).fillColor(BLK).font('Helvetica-Bold');
            T('CUSTOMER', cX + 10, sY + 4);

            const cd = [['Cust Name:', txt(snap.name)], ['Address:', txt(snap.address)], ['Tel:', txt(snap.contactNo)], ['Email:', txt(snap.email)]];
            let cf = sY + 22;
            cd.forEach(([l, v]) => {
                doc.fontSize(7.5).fillColor(BLK).font('Helvetica-Bold'); T(l, cX + 10, cf, { width: 75 });
                doc.font('Helvetica').fontSize(7.5);
                doc.text(v, cX + 90, cf, { width: cW - 100, lineBreak: true });
                const th = doc.heightOfString(v, { width: cW - 100, font: 'Helvetica', size: 8.5 });
                cf += Math.max(18, th + 4);
            });

            const md_rows = 8;
            const md_h = mTH / md_rows;
            const finalVendorCode = (invoice.vendorCode && invoice.vendorCode.trim()) ? invoice.vendorCode.trim() : 'NA';
            const md = [['INVOICE NO:', txt(invoice.invoiceNumber), false], ['DATE:', fmtDate(invoice.invoiceDate), false], ['CUSTOMER ID:', txt(snap.customerId), false], ['DATE OF JOINING:', fmtDate((invoice.candidates || [])[0]?.dateOfJoining), false], ['DUE DATE:', fmtDate(invoice.dueDate), true], ['VENDOR CODE:', txt(finalVendorCode), false], ['Dept Code:', txt(invoice.deptCode || 'NA'), false], ['Customer GSTN:', txt(snap.gstNo), false]];
            // Match reference: metadata label column aligns to Chargeable Salary width,
            // value column aligns to (Rate + Chargeable Amt) combined width.
            // mLW already defined earlier as sw[2]

            // Internal metadata grid lines: one dotted pass for uniform texture.
            doc.strokeColor(BLK).lineWidth(0.5).lineCap('butt');
            doc.moveTo(snapLine(mX + mLW), snapLine(sY)).lineTo(snapLine(mX + mLW), snapLine(sY + mTH)).stroke();
            for (let i = 1; i < md_rows; i++) {
                const rowY = sY + i * md_h;
                doc.moveTo(snapLine(mX), snapLine(rowY)).lineTo(snapLine(MR), snapLine(rowY)).stroke();
            }

            let mf = sY;
            md.forEach(([l, v, o]) => {
                // Center label/value text in each metadata row cell.
                const labelSize = 9;
                doc.font('Helvetica-Bold').fontSize(labelSize).fillColor(o ? ORANGE : GRY);
                const labelLineHeight = doc.currentLineHeight();
                const labelTextWidth = doc.widthOfString(l);
                const labelX = mX + Math.max(0, (mLW - labelTextWidth) / 2);
                const labelY = mf + (md_h - labelLineHeight) / 2;
                T(l, labelX, labelY);

                const baseValueSize = l === 'INVOICE NO:' ? 9.5 : 8.5;
                let vSize = baseValueSize;
                const valueFont = l === 'INVOICE NO:' ? 'Helvetica-Bold' : 'Helvetica';
                doc.font(valueFont).fontSize(vSize);
                // Shrink font until it fits the width
                while (vSize > 5 && doc.widthOfString(v) > (mW - mLW - 6)) {
                    vSize -= 0.5;
                    doc.fontSize(vSize);
                }

                // Value: centered in its cell
                const valueLineHeight = doc.currentLineHeight();
                const valueTextWidth = doc.widthOfString(v);
                const valueCellWidth = mW - mLW;
                const valueX = mX + mLW + Math.max(0, (valueCellWidth - valueTextWidth) / 2);
                const valueY = mf + (md_h - valueLineHeight) / 2 + 1;
                doc.fillColor(o ? ORANGE : BLK);
                T(v, valueX, valueY);
                mf += md_h;
            });

            y = sY + mTH;

            // ──────── SERVICE TABLE ────────
            // Reuse shared column geometry.

            const serviceHeaderTopY = y;
            const serviceHeaderTopH = 22;

            doc.rect(ML, y, CW, serviceHeaderTopH).fill(BLUE);
            doc.fontSize(7.5).fillColor('white').font('Helvetica-Bold');
            T('Description of Service', sx[1], y + 6, { width: sw[1], align: 'center' });
            y += serviceHeaderTopH;

            const chgText = 'Sourcing, Recruiting and Onboarding Charges For:';

            const chgH = Math.max(22, doc.heightOfString(chgText, { width: sw[1] - 10, font: 'Helvetica-Bold', size: 8.5 }) + 10);
            const serviceHeaderTotalH = serviceHeaderTopH + chgH;
            const mergedHeaderTextY = serviceHeaderTopY + Math.max(5, Math.round((serviceHeaderTotalH - 8.5) / 2) - 1);

            // Keep chargeable header area color fully uniform across both header rows.
            doc.rect(sx[2], serviceHeaderTopY, MR - sx[2], serviceHeaderTotalH).fill(BLUE);

            doc.rect(ML, y, CW, chgH).fill(BLUE);
            doc.fontSize(7.5).fillColor('white').font('Helvetica-Bold');
            doc.text(chgText, sx[1] + 5, y + 5, { width: sw[1] - 10 });
            T('S.No.', sx[0], mergedHeaderTextY, { width: sw[0], align: 'center' });
            T('Chargeable Salary', sx[2], mergedHeaderTextY, { width: sw[2], align: 'center' });
            T('Rate', sx[3], mergedHeaderTextY, { width: sw[3], align: 'center' });
            T('Chargeable Amt', sx[4], mergedHeaderTextY, { width: sw[4], align: 'center' });
            y += chgH;

            // Extend service table column lines upward through header rows.
            doc.strokeColor('#d7e4f3').lineWidth(0.5);
            [sx[1], sx[2]].forEach((x) => {
                doc.moveTo(x, sY + mTH).lineTo(x, y).stroke();
            });

            // Keep chargeable header sections distinct with dotted dividers.
            doc.strokeColor('#d7e4f3').lineWidth(0.6);
            [sx[3], sx[4]].forEach((x) => {
                doc.moveTo(x, serviceHeaderTopY).lineTo(x, y).stroke();
            });

            const tableHeaderY = sY + mTH;
            const sTableTop = tableHeaderY;
            let tableStartContentY = y;
            let sNoCounter = 1;
            const descLabelW = Math.max(80, Math.round(sw[1] * 0.39));

            (invoice.candidates || []).forEach((c, idx) => {
                const rowH = 21;
                let h2 = Math.max(rowH, doc.heightOfString(txt(c.designation), { width: sw[1] - 100, font: 'Helvetica', size: 8.5 }) + 8);
                let h3 = Math.max(rowH, doc.heightOfString(txt(c.level), { width: sw[1] - 100, font: 'Helvetica', size: 8.5 }) + 8);

                // draw backgrounds for row 2 left side, row 3 left side
                doc.rect(sx[1], y + rowH, descLabelW, h2).fill('#e2e2e2');
                doc.rect(sx[1], y + rowH + h2, descLabelW, h3).fill('#e2e2e2');

                // row 1 content
                doc.fillColor(BLK).font('Helvetica');
                const pad = (rowH - 8.5) / 2;
                T(String(sNoCounter++), sx[0], y + pad, { width: sw[0], align: 'center' });
                doc.font('Helvetica-Bold');
                T(txt(c.name), sx[1], y + pad, { width: sw[1], align: 'center' });

                const blockH = rowH + h2 + h3;
                // Keep the salary/rate/amount area visually merged and greyed out.
                doc.rect(sx[2], y, MR - sx[2], blockH).fill('#e2e2e2');

                if (idx === 0) {
                    // Values vertically centered within the merged block.
                    const mergedTextY = y + Math.round((blockH - 8.5) / 2);
                    doc.fillColor(BLK).font('Helvetica-Bold');

                    // Chargeable Salary — shrink to fit one line
                    let csFontSize = 8.5;
                    const csText = 'Rs. ' + fmt(invoice.chargeableSalary);
                    doc.fontSize(csFontSize);
                    while (csFontSize > 5 && doc.widthOfString(csText) > (sw[2] - 12)) { csFontSize -= 0.5; doc.fontSize(csFontSize); }
                    T(csText, sx[2], mergedTextY + (8.5 - csFontSize) / 2, { width: sw[2] - 10, align: 'right' });

                    // Rate — shrink to fit one line
                    let rateFontSize = 8.5;
                    const rateText = (invoice.rate || 0).toFixed(2) + '%';
                    doc.fontSize(rateFontSize);
                    while (rateFontSize > 5 && doc.widthOfString(rateText) > (sw[3] - 6)) { rateFontSize -= 0.5; doc.fontSize(rateFontSize); }
                    T(rateText, sx[3], mergedTextY + (8.5 - rateFontSize) / 2, { width: sw[3], align: 'center' });

                    // Chargeable Amount — shrink to fit one line
                    let caFontSize = 8.5;
                    const caText = 'Rs. ' + fmt(invoice.chargeableAmount);
                    doc.fontSize(caFontSize);
                    while (caFontSize > 5 && doc.widthOfString(caText) > (sw[4] - 12)) { caFontSize -= 0.5; doc.fontSize(caFontSize); }
                    T(caText, sx[4], mergedTextY + (8.5 - caFontSize) / 2, { width: sw[4] - 10, align: 'right' });
                }

                // horizontal separator after row 1
                doc.strokeColor(BLK).lineWidth(0.5);
                doc.moveTo(ML, y + rowH).lineTo(sx[2], y + rowH).stroke();

                // row 2 content
                doc.fillColor(BLK).font('Helvetica');
                T(String(sNoCounter++), sx[0], y + rowH + pad, { width: sw[0], align: 'center' });
                doc.fontSize(8.5).font('Helvetica');
                T('Designation:', sx[1] + 5, y + rowH + pad, { width: descLabelW - 10, align: 'right' });
                doc.font('Helvetica');
                doc.text(txt(c.designation), sx[1] + descLabelW + 5, y + rowH + pad, { width: sw[1] - descLabelW - 10 });

                // horizontal separator after row 2
                doc.strokeColor(BLK).lineWidth(0.5);
                doc.moveTo(ML, y + rowH + h2).lineTo(sx[2], y + rowH + h2).stroke();

                // row 3 content
                doc.fillColor(BLK).font('Helvetica');
                T(String(sNoCounter++), sx[0], y + rowH + h2 + pad, { width: sw[0], align: 'center' });
                doc.fontSize(8.5).font('Helvetica');
                T('Level:', sx[1] + 5, y + rowH + h2 + pad, { width: descLabelW - 10, align: 'right' });
                doc.font('Helvetica');
                doc.text(txt(c.level), sx[1] + descLabelW + 5, y + rowH + h2 + pad, { width: sw[1] - descLabelW - 10 });

                // horizontal separator after row 3
                doc.strokeColor(BLK).lineWidth(0.5);
                doc.moveTo(ML, y + rowH + h2 + h3).lineTo(MR, y + rowH + h2 + h3).stroke();

                // Vertical lines restricted to this candidate block ONLY
                [sx[1], sx[2], sx[3], sx[4]].forEach(x => {
                    doc.moveTo(x, y).lineTo(x, y + blockH).stroke();
                });
                doc.moveTo(sx[1] + descLabelW, y + rowH).lineTo(sx[1] + descLabelW, y + blockH).stroke(); // between label and value

                y += blockH;
            });

            // Add empty space if needed
            let emptySpaceStart = y;
            if (y - tableStartContentY < 60) {
                y = tableStartContentY + 60;
            }

            // ──────── GST & TOTAL SECTION (aligned under table) ────────
            // Use sx[2] for more width to avoid text wrapping, divider sx[4]
            const gL = sx[2], gVL = sx[4], gVW = MR - sx[4];
            const gstH = 19; // Row height for each summary row

            // Build the list of summary rows dynamically
            const summaryRows = [];
            if (invoice.cgst > 0) {
                summaryRows.push({ label: 'CGST@9%', value: invoice.cgst, bold: false });
                summaryRows.push({ label: 'SGST@9%', value: invoice.sgst, bold: false });
            } else if (invoice.igst > 0) {
                summaryRows.push({ label: 'IGST@18%', value: invoice.igst, bold: false });
            }
            summaryRows.push({ label: 'Total GST', value: invoice.totalGst, bold: true });
            summaryRows.push({ label: 'Total Amount', value: invoice.totalAmount, bold: true });
            summaryRows.push({ label: 'Net Payable', value: invoice.netPayable, bold: true });

            const gstTop = y;
            const totalSummaryH = summaryRows.length * gstH;

            // Draw outer box: top line, bottom line, and vertical divider
            doc.strokeColor(BLK).lineWidth(0.5);
            doc.moveTo(snapLine(gL), snapLine(y)).lineTo(snapLine(MR), snapLine(y)).stroke();                         // Top border
            doc.moveTo(snapLine(gVL), snapLine(y + totalSummaryH)).lineTo(snapLine(MR), snapLine(y + totalSummaryH)).stroke(); // Bottom border (amount only)
            doc.moveTo(snapLine(gVL), snapLine(y)).lineTo(snapLine(gVL), snapLine(y + totalSummaryH)).stroke();       // Vertical divider

            // Place text for each row
            summaryRows.forEach((row) => {
                // Only add a divider line above "Net Payable" and only in the Rs column
                if (row.label === 'Net Payable') {
                    doc.strokeColor(BLK).lineWidth(0.5);
                    doc.moveTo(snapLine(gVL), snapLine(y)).lineTo(snapLine(MR), snapLine(y)).stroke();
                }

                doc.fontSize(7).fillColor(BLK).font(row.bold ? 'Helvetica-Bold' : 'Helvetica');
                T(row.label, gL + 10, y + 5, { width: gVL - gL - 15, align: 'right' });

                // Shrink value font to fit on one line
                let gstValSize = 7.5;
                const gstValText = 'Rs. ' + fmt(row.value);
                doc.fontSize(gstValSize).fillColor(BLK).font(row.bold ? 'Helvetica-Bold' : 'Helvetica');
                while (gstValSize > 5 && doc.widthOfString(gstValText) > (gVW - 18)) { gstValSize -= 0.5; doc.fontSize(gstValSize); }
                T(gstValText, gVL + 5, y + 5 + (7.5 - gstValSize) / 2, { width: gVW - 15, align: 'right' });
                y += gstH;
            });

            // The ONE internal vertical line continuing through empty space and GST section
            doc.moveTo(gVL, emptySpaceStart).lineTo(gVL, gstTop).stroke();

            // ──────── AMT IN WORDS ────────
            if (y + 165 > H - 22) {
                // Draw footer on current page before splitting
                doc.rect(ML, H - 22, CW, 22).fill(ORANGE);
                doc.fontSize(8).fillColor('white').font('Helvetica-Bold');
                T('Thank you for giving us business! Any invoice / accounts related query please call our Accounts - +91 22 42959123', ML + 10, H - 22 + 7);
                doc.addPage();
                y = MT;
            }

            y += 10;
            const ws = numberToWords(invoice.netPayable) + ' Only';
            const al = 'Amt In Words: ';
            // Shrink font until the full "Amt In Words: ..." string fits on one line
            let amtWordSize = 10;
            doc.font('Helvetica-Bold').fontSize(amtWordSize);
            let aw = doc.widthOfString(al);
            let ww = doc.widthOfString(ws);
            while (amtWordSize > 6 && (aw + ww) > CW - 10) {
                amtWordSize -= 0.5;
                doc.fontSize(amtWordSize);
                aw = doc.widthOfString(al);
                ww = doc.widthOfString(ws);
            }
            const fullW = aw + ww;
            const startX = ML + (CW - fullW) / 2;
            doc.fontSize(amtWordSize).fillColor(BLK).font('Helvetica-Bold');
            T(al, startX, y);
            doc.fillColor(ORANGE).font('Helvetica-Bold');
            T(ws, startX + aw, y);
            y += 20;

            // ──────── BANK + TERMS (LEFT) and SIGNATURE (RIGHT) ────────
            let bY = y;
            const bW2 = Math.floor(CW * 0.62), sW2 = CW - bW2;
            const sigX = ML + bW2;
            const bankHdrH = 18, bankRowH = 21;
            const termsHdrH = 16, termsBodyH = 101;
            const bankRows = 3;
            const bankBodyH = bankRows * bankRowH;
            const leftPanelH = bankHdrH + bankBodyH + termsHdrH + termsBodyH;
            const sectionBottom = bY + leftPanelH;

            if (sectionBottom > H - 24) {
                doc.addPage();
                bY = MT;
            }

            const finalSectionBottom = bY + leftPanelH;

            // Headers
            doc.rect(ML, bY, bW2, bankHdrH).fill(BLUE);
            doc.fontSize(9).fillColor('white').font('Helvetica-Bold');
            T('OUR BANK & OTHER DETAILS', ML, bY + 4, { width: bW2, align: 'center' });

            doc.rect(sigX, bY, sW2, bankHdrH).fill(BLUE);
            doc.fontSize(9).fillColor('white').font('Helvetica-Bold');
            T('AUTHORIZED SIGNATURE', sigX, bY + 4, { width: sW2, align: 'center' });

            // Outer frame + major divider (dotted)
            // Outer frame + major divider (dotted)
            doc.strokeColor(BLK).lineWidth(0.5);
            doc.moveTo(snapLine(ML), snapLine(bY)).lineTo(snapLine(MR), snapLine(bY)).stroke();
            doc.moveTo(snapLine(ML), snapLine(finalSectionBottom)).lineTo(snapLine(MR), snapLine(finalSectionBottom)).stroke();
            doc.moveTo(snapLine(sigX), snapLine(bY)).lineTo(snapLine(sigX), snapLine(finalSectionBottom)).stroke();

            // Bank rows (left top)
            const bkTop = bY + bankHdrH;
            const bkL_Col = Math.floor(bW2 * 0.47), bkR_Col = bW2 - bkL_Col;
            const leftLabelW = 78, rightLabelW = 82;

            // Clean up CA number and derive IFSC from legacy mixed values if needed.
            const rawCaNumber = txt(co.caNumber);
            let cleanCaNumber = rawCaNumber.split(/[\s\-({\[]*IFSC/i)[0].trim();
            if (cleanCaNumber.endsWith('-')) {
                cleanCaNumber = cleanCaNumber.substring(0, cleanCaNumber.length - 1).trim();
            }

            let resolvedIfsc = txt(co.ifscCode).toUpperCase();
            if (!resolvedIfsc || resolvedIfsc === 'NA') {
                const ifscMatch = rawCaNumber.match(/[A-Z]{4}0[A-Z0-9]{6}/i);
                if (ifscMatch && ifscMatch[0]) {
                    resolvedIfsc = ifscMatch[0].toUpperCase();
                    // Remove extracted IFSC text from CA part for clean rendering.
                    cleanCaNumber = rawCaNumber
                        .replace(ifscMatch[0], '')
                        .replace(/IFSC\s*:?/i, '')
                        .replace(/[\-|/]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
            }

            const bD = [
                ['PAN NUMBER:', txt(co.panNumber), 'Account Name:', txt(co.accountName || coName)],
                ['GSTN:', txt(co.gstn), 'Bank & Branch:', txt((co.bankName || '') + ', ' + (co.branchName || ''))],
                ['SAC Code:', txt(coSac), 'CA Num/IFSC:', cleanCaNumber + ' / ' + (resolvedIfsc || 'NA')]
            ];

            for (let i = 0; i < bankRows; i++) {
                const rowY = bkTop + i * bankRowH;
                doc.strokeColor(BLK).lineWidth(0.5);
                doc.moveTo(ML, rowY).lineTo(sigX, rowY).stroke();
                doc.moveTo(ML + bkL_Col, rowY).lineTo(ML + bkL_Col, rowY + bankRowH).stroke();

                let [l1, v1, l2, v2] = bD[i];
                const padY = (bankRowH - 8.5) / 2;

                doc.fontSize(6.5).fillColor(GRY).font('Helvetica-Bold');
                T(l1, ML + 8, rowY + padY, { width: leftLabelW, align: 'left' });
                let v1Size = 6.5;
                doc.fontSize(v1Size).fillColor(BLK).font('Helvetica');
                while (v1Size > 5 && doc.widthOfString(v1) > (bkL_Col - leftLabelW - 12)) {
                    v1Size -= 0.5;
                    doc.fontSize(v1Size);
                }
                T(v1, ML + 8 + leftLabelW, rowY + padY + (6.5 - v1Size) / 2, { width: bkL_Col - leftLabelW - 12, align: 'left' });

                if (i === 2) {
                    // Specialized stacking for CA & IFSC in the last row right column
                    const caVal = cleanCaNumber;
                    const ifscVal = resolvedIfsc || 'NA';

                    doc.fontSize(6.5).fillColor(GRY).font('Helvetica-Bold');
                    T('CA Number:', ML + bkL_Col + 8, rowY + 4, { width: rightLabelW, align: 'left' });
                    T('IFSC Code:', ML + bkL_Col + 8, rowY + 13, { width: rightLabelW, align: 'left' });

                    doc.fontSize(6.5).fillColor(BLK).font('Helvetica');
                    T(caVal, ML + bkL_Col + 8 + rightLabelW, rowY + 4, { width: bkR_Col - rightLabelW - 12, align: 'left' });
                    T(ifscVal, ML + bkL_Col + 8 + rightLabelW, rowY + 13, { width: bkR_Col - rightLabelW - 12, align: 'left' });
                } else {
                    doc.fontSize(6.5).fillColor(GRY).font('Helvetica-Bold');
                    T(l2, ML + bkL_Col + 8, rowY + padY, { width: rightLabelW, align: 'left' });
                    // Shrink value font to keep on one line instead of wrapping
                    let v2Size = 6.5;
                    doc.fontSize(v2Size).fillColor(BLK).font('Helvetica');
                    while (v2Size > 4.5 && doc.widthOfString(v2) > (bkR_Col - rightLabelW - 12)) {
                        v2Size -= 0.5;
                        doc.fontSize(v2Size);
                    }
                    T(v2, ML + bkL_Col + 8 + rightLabelW, rowY + padY + (6.5 - v2Size) / 2, { width: bkR_Col - rightLabelW - 12, align: 'left' });
                }
            }

            const bankBottom = bkTop + bankBodyH;
            doc.strokeColor(BLK).lineWidth(0.5);
            doc.moveTo(ML, bankBottom).lineTo(sigX, bankBottom).stroke();

            // Terms below bank details (left only)
            const tY = bankBottom;
            doc.rect(ML, tY, bW2, termsHdrH).fill(BLUE);
            doc.fontSize(9).fillColor('white').font('Helvetica-Bold');
            T('TERMS & CONDITIONS', ML, tY + 4, { width: bW2, align: 'center' });

            doc.strokeColor(BLK).lineWidth(0.5);
            doc.rect(ML, tY + termsHdrH, bW2, termsBodyH).stroke();

            doc.fontSize(7.5).fillColor(BLK).font('Helvetica-Bold');
            const tms = [
                '1. Please comply with TDS provisions, if applicable.',
                '2. All payments should be made in favour of "' + coName + '" only.',
                '3. Interest @21% per annum will be charged beyond due date.',
                '4. Payment once made shall not be refunded.',
                '5. All disputes are within Mumbai jurisdiction only.'
            ];
            tms.forEach((t, i) => T(t, ML + 14, tY + termsHdrH + 12 + (i * 19)));

            // Signature panel content (right full-height)
            doc.fontSize(10).fillColor(BLK).font('Helvetica-Bold');
            T('For ' + coName, sigX, bY + 45, { width: sW2, align: 'center' });

            const sO = (invoice.signatures && invoice.signatures.length > 0) ? invoice.signatures[invoice.signatures.length - 1] : null;
            const sigImg = (sO && sO.isSigned && sO.signatureImage) ? sO.signatureImage : null;
            const sealImg = (sO && sO.sealImage) ? sO.sealImage : options.settingsSealImage;
            const sigAreaTop = bY + 60;
            const sigAreaBottom = finalSectionBottom - 66; // Matches 15pt gap from both labels (45+15=60, 51+15=66)
            const sigAreaH = sigAreaBottom - sigAreaTop;
            const sigCenterX = sigX + (sW2 / 2);

            if (sigImg) {
                try {
                    const b6 = sigImg.replace(/^data:image\/\w+;base64,/, '');
                    const imgW = Math.min(sW2 - 22, 165);
                    doc.image(Buffer.from(b6, 'base64'), sigCenterX - (imgW / 2), sigAreaTop, { fit: [imgW, sigAreaH], align: 'center', valign: 'center' });
                } catch (e) { }
            }
            if (sealImg) {
                try {
                    const sb = (typeof sealImg === 'string' && sealImg.startsWith('data:image')) ? Buffer.from(sealImg.replace(/^data:image\/\w+;base64,/, ''), 'base64') : sealImg;
                    const sealW = Math.min(sW2 - 10, 175);
                    doc.image(sb, sigCenterX - (sealW / 2), sigAreaTop, { fit: [sealW, sigAreaH], align: 'center', valign: 'center' });
                } catch (e) { }
            }

            doc.fontSize(10).fillColor(BLK).font('Helvetica-Bold');
            T('Authorised Signatory', sigX, finalSectionBottom - 51, { width: sW2, align: 'center' });

            y = finalSectionBottom;

            // ──────── FOOTER (aligned to margins) ────────
            const footH = 22, footY = y;
            doc.rect(ML, footY, CW, footH).fill(ORANGE);
            doc.fontSize(8).fillColor('white').font('Helvetica-Oblique');
            T('Thank you for giving us business! Any invoice / accounts related query please call our Accounts - +91 22 42959123', ML, footY + 7, { width: CW, align: 'center' });

            // Dotted outer perimeter lines (left and right)
            doc.strokeColor(BLK).lineWidth(0.5);
            doc.moveTo(snapLine(ML), snapLine(MT)).lineTo(snapLine(ML), snapLine(footY + footH)).stroke();
            doc.moveTo(snapLine(MR), snapLine(MT)).lineTo(snapLine(MR), snapLine(footY + footH)).stroke();

            doc.on('end', resolve);
            doc.on('error', reject);
            if (typeof res.on === 'function') res.on('error', reject);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ════════════════════════════════════════════════════════════
function numberToWords(num) {
    const raw = Number(String(num ?? 0).replace(/,/g, ''));
    if (!Number.isFinite(raw) || raw === 0) return 'Zero';
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    function convert(n) {
        if (n < 20) return ones[n];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
        if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + convert(n % 100) : '');
        return '';
    }
    let n = Math.floor(Math.abs(raw));
    const paise = Math.round((Math.abs(raw) - n) * 100);
    let result = '';
    if (n >= 10000000) { result += convert(Math.floor(n / 10000000)) + ' Crore '; n %= 10000000; }
    if (n >= 100000) { result += convert(Math.floor(n / 100000)) + ' Lakh '; n %= 100000; }
    if (n >= 1000) { result += convert(Math.floor(n / 1000)) + ' Thousand '; n %= 1000; }
    if (n > 0) result += convert(n);
    result = 'Rupees ' + result.trim();
    if (paise > 0) result += ' and ' + convert(paise) + ' Paise';
    return result;
}

module.exports = router;


