# 🚀 Professional CRM Dashboard

A powerful, modern Customer Relationship Management (CRM) platform built with Node.js, Express, MongoDB, and EJS. Designed to help businesses seamlessly manage leads, sales pipelines, clients, tasks, and invoicing with an intuitive, dynamic user interface.

## 🌟 Key Features

*   **Lead & Client Management:** Easily track potential customers from initial contact to "Won" status. Automatically separates active leads from signed clients based on status and documentation.
*   **Dynamic Sales Pipeline:** A drag-and-drop Kanban board to visualize and manage deals across different stages (New, Work-in-Progress, Negotiation, Won, Lost).
*   **Role-Based Access Control (RBAC):** Secure access levels for Super Admin, Admin, Manager, and Staff to ensure data privacy and hierarchical visibility.
*   **Task & Activity Tracking:** Assign tasks, log interactions, and keep a complete timeline of every touchpoint with a client.
*   **Invoicing System:** Generate, manage, and track professional PDF invoices directly within the platform.
*   **Beautiful UI/UX:** Responsive, modern dashboard built with custom CSS, featuring smooth transitions, intuitive navigation, and quick-action modals.

## 🛠️ Tech Stack

*   **Backend:** Node.js, Express.js
*   **Database:** MongoDB, Mongoose
*   **Frontend:** HTML5, CSS3, JavaScript (Vanilla), EJS Templating
*   **Authentication:** JWT / Express-Session
*   **File Uploads:** Multer (for handling documents like signed agreements)

## 📦 Installation & Setup

1. **Clone the repository:**
   `git clone https://github.com/sathvik08bhat/CRM-Dashboard.git`
   `cd CRM-Dashboard`

2. **Install dependencies:**
   `npm install`

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory and add the following:
   `PORT=3000`
   `MONGODB_URI=mongodb://localhost:27017/crm_sales`

4. **Start the Development Server:**
   `npm run dev`

5. **Access the Application:**
   Open your browser and navigate to `http://localhost:3000`

## 👥 Default Admin Access
*(If using a seeded database script)*
*   **Email:** admin@crm.com
*   **Password:** admin123

## 🏗️ Project Structure

*   `models/` - Mongoose database schemas (Lead, User, Invoice, etc.)
*   `routes/` - Express API and page routes
*   `public/` - Static assets (CSS, JS, Images, Icons)
*   `views/` - EJS templates for rendering the UI
*   `middleware/` - Custom Express middleware (Authentication, etc.)
*   `utils/` - Helper functions and utilities
*   `uploads/` - Directory for uploaded client documents
*   `server.js` - Main application entry point

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/sathvik08bhat/CRM-Dashboard/issues).

## 📝 License

This project is licensed under the MIT License.
