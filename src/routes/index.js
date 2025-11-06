const express = require('express');
const sessionRoutes = require('./sessionRoutes');
const messageRoutes = require('./messageRoutes');
const logRoutes = require('./logRoutes');

const router = express.Router();

router.use('/sessions', sessionRoutes);
router.use('/agents', messageRoutes);
router.use('/logs', logRoutes);

module.exports = router;
