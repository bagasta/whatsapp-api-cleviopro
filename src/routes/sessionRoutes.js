const express = require('express');
const sessionController = require('../controllers/sessionController');

const router = express.Router();

router.post('/', sessionController.createSession);
router.delete('/:agentId', sessionController.deleteSession);
router.post('/:agentId/reconnect', sessionController.reconnectSession);

module.exports = router;
