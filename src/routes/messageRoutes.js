const express = require('express');
const messageController = require('../controllers/messageController');

const router = express.Router({ mergeParams: true });

router.post('/:agentId/run', messageController.sendMessage);

module.exports = router;
