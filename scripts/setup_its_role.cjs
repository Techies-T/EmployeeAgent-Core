const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../server/database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Fetch current RBAC_POLICIES
    db.get("SELECT value FROM settings WHERE key='RBAC_POLICIES'", (err, row) => {
        if (err || !row) {
            console.error("Failed to fetch RBAC_POLICIES", err);
            return;
        }
        let policies = JSON.parse(row.value);
        
        // Add its role
        policies['its'] = {
            "name": "IT Support (ITS)",
            "allowed_widgets": ["app:app-monitor", "app:gemini"],
            "allowed_models": ["*"],
            "allowed_actions": ["action:use_mcp_tools"]
        };
        
        const newPoliciesStr = JSON.stringify(policies);
        db.run("UPDATE settings SET value = ? WHERE key = 'RBAC_POLICIES'", [newPoliciesStr], (err) => {
            if (err) console.error("Error updating policies", err);
            else console.log("Added ITS role to RBAC_POLICIES");
        });
        
        // Update analyst@example.com to its
        db.run("UPDATE users SET role = 'its' WHERE email = 'analyst@example.com'", (err) => {
            if (err) console.error("Error updating user", err);
            else console.log("Updated analyst@example.com to ITS role");
        });
    });
});
