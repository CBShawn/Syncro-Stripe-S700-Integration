const express = require("express");

module.exports = (req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    return next();
  }

  express.json({
    type: [
      "application/json",
      "text/plain",
      "application/x-www-form-urlencoded",
    ],
  })(req, res, next);
};
