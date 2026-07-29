#!/usr/bin/env node
import { createRouter } from "../config/create-router.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: npm run dev -- "your task prompt"');
  process.exit(1);
}

const router = createRouter();
const decision = await router.route(prompt);
console.log(JSON.stringify(decision, null, 2));
