const cors = require("cors");

module.exports = cors({
  origin: true,
  methods: [
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "OPTIONS"
  ],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-extension-auth",
    "x-extension-key",
    "x-requested-with",
  ],
  credentials: true,
});
