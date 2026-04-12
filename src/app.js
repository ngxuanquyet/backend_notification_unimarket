const express = require('express');
const cors = require('cors');
const { registerRoutes } = require('./presentation/routes/registerRoutes');

function createApp(controller) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  registerRoutes(app, controller);
  return app;
}

module.exports = {
  createApp
};
