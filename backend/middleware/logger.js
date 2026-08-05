module.exports = (req, res, next) => {
  console.log("===== INCOMING REQUEST =====");
  console.log(req.method, req.url);
  next();
};
