function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function isAgreementAttachment(attachment) {
    const haystack = [
        attachment?.originalName,
        attachment?.filename,
        attachment?.description,
        attachment?.type
    ].map(normalizeText).join(' ');

    return /\bagreement\b|\bcontract\b|\bsigned\b/.test(haystack);
}

function hasAgreementAttachment(lead) {
    return Array.isArray(lead?.attachments) && lead.attachments.length > 0;
}

function getPrimaryContact(lead) {
    return Array.isArray(lead?.contacts) && lead.contacts.length > 0 ? lead.contacts[0] : {};
}

function normalizeLeadClientFields(lead) {
    if (!lead) return lead;
    const firstContact = getPrimaryContact(lead);

    if (!lead.contactPerson && firstContact.name) lead.contactPerson = firstContact.name;
    if (!lead.designation && firstContact.designation) lead.designation = firstContact.designation;
    if (!lead.email && firstContact.email) lead.email = firstContact.email;
    if (!lead.mobile && firstContact.mobile) lead.mobile = firstContact.mobile;

    return lead;
}

function isLeadClient(lead) {
    const status = normalizeText(lead?.status);
    if (!status) return false;

    const explicitClientStatus = status === 'client' || status === 'converted client' || status === 'converted-to-client';
    const agreementSignedStatus = status === 'agreement signed';

    return explicitClientStatus || (agreementSignedStatus && hasAgreementAttachment(lead));
}

function leadClientQuery() {
    return {
        $or: [
            { status: { $regex: /^client$/i } },
            { status: { $regex: /^converted client$/i } },
            {
                status: { $regex: /^agreement signed$/i },
                attachments: { $exists: true, $ne: [] }
            }
        ]
    };
}

module.exports = {
    getPrimaryContact,
    hasAgreementAttachment,
    isAgreementAttachment,
    isLeadClient,
    leadClientQuery,
    normalizeLeadClientFields
};
