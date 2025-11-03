const express = require('express');
const messageController = require('../controllers/messageController');
const sessionController = require('../controllers/sessionController');

const router = express.Router({ mergeParams: true });

router.get('/:agentId/get-status', sessionController.getSessionStatus);
router.post('/:agentId/run', messageController.sendMessage);
router.post('/:agentId/messages', messageController.sendDirectMessage);
router.post('/:agentId/media', messageController.sendMediaMessage);

module.exports = router;
