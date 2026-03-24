const jwt = require("jsonwebtoken");

/**
 * Express middleware that verifies a JWT Bearer token.
 * On success, sets `req.user` with the decoded payload (contains `user_id`).
 * On failure, returns 401.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

/**
 * Generate a JWT for a given user.
 * @param {{ user_id: string, email: string, name: string }} user
 * @returns {string}
 */
function generateToken(user) {
  return jwt.sign(
    { user_id: user.user_id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || "7d" }
  );
}

module.exports = { authenticateToken, generateToken };
