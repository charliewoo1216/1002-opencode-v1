@echo off
rem Join part00..part03 in this folder into one zip file.
cd /d "%~dp0"
copy /b ocx-package.zip.part00 + ocx-package.zip.part01 + ocx-package.zip.part02 + ocx-package.zip.part03 ocx-windows-x64-package.zip
if errorlevel 1 (echo FAILED: check that all 4 part files are in this folder & exit /b 1)
echo.
echo Created: ocx-windows-x64-package.zip
echo Verify: compare the first 16 characters below with the last line of SHA256SUMS.txt
certutil -hashfile ocx-windows-x64-package.zip SHA256
echo.
echo Next: unzip it and open README.txt inside the folder.
pause
