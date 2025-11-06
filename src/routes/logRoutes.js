const express = require('express');
const logController = require('../controllers/logController');

const router = express.Router();

router.get('/messages', logController.getMessageLogs);

module.exports = router;
