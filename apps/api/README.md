# API App

Express-only API boundary for Test Flow AI.

`src/server.ts` creates and starts the Express application. It currently registers the
service facades under `services/*`, which delegate to the existing implementations while
the repo moves toward service-oriented boundaries.
