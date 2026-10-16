SKYFRONT MULTIPLAYER — STARTER PACKAGE
======================================

WHAT'S INCLUDED
- public/Skyfront.html: your supplied game file
- server.js: starter web server and Socket.IO room foundation
- package.json: Node.js project setup
- start-server.bat: Windows helper to install dependencies and start the server

IMPORTANT
This is the server foundation, not a finished multiplayer version of the game.
The current Skyfront HTML has not yet been connected to room buttons or to a
shared, server-authoritative simulation. Players will not yet share country,
army, economy, battle, or diplomacy changes until those game systems are wired
into the multiplayer server.

HOW TO START (Windows 10/11)
1. Extract the ZIP to a folder you can find, such as your Desktop.
2. Make sure Node.js is installed.
3. Double-click start-server.bat.
   - The first run installs the packages; this needs an internet connection.
   - A command window will stay open while the server runs.
4. On the same laptop, open http://localhost:3000/Skyfront.html

To stop the server, click the command window and press Ctrl+C.

For now, localhost works only on the computer running the server.
To let friends connect from other networks, we must configure secure remote
access or deploy the server online. Do not disable your firewall entirely or
expose random ports.

If double-clicking the BAT file is blocked, open Command Prompt in this folder
and run:
  npm install
  npm start
