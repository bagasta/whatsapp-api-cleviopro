module.exports = function notFound(req, res) {
  res.status(404).json({ error: 'Not Found' });
};
