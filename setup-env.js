#!/usr/bin/env node

/**
 * Quick setup script to help configure environment variables
 * Run this script to interactively set up your backend environment
 */

import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setupEnvironment() {
  console.log('🚀 Backend Environment Setup');
  console.log('============================\n');
  
  console.log('This script will help you set up your backend environment variables.\n');
  
  console.log('📋 You need your Supabase Service Role Key:');
  console.log('1. Go to https://supabase.com/dashboard');
  console.log('2. Select your project');
  console.log('3. Go to Settings > API');
  console.log('4. Copy the "service_role" key (NOT the anon key)\n');
  
  const serviceRoleKey = await question('🔑 Enter your Supabase Service Role Key: ');
  
  if (!serviceRoleKey || !serviceRoleKey.startsWith('eyJ')) {
    console.log('❌ Invalid key format. The service role key should start with "eyJ"');
    console.log('Make sure you copied the service_role key, not the anon key.');
    rl.close();
    return;
  }
  
  try {
    // Read the current .env file
    let envContent = readFileSync('.env', 'utf8');
    
    // Replace the placeholder with the actual key
    envContent = envContent.replace(
      'SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE',
      `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`
    );
    
    // Write back to .env file
    writeFileSync('.env', envContent);
    
    console.log('✅ Environment variables updated successfully!');
    console.log('🚀 You can now start your backend server with: npm start');
    
  } catch (error) {
    console.log('❌ Error updating .env file:', error.message);
    console.log('Please manually update the .env file with your service role key.');
  }
  
  rl.close();
}

setupEnvironment().catch(console.error);