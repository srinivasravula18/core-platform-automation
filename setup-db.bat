@echo off
setlocal

:: Default connection parameters
set DB_HOST=localhost
set DB_PORT=5432
set DB_USER=postgres
set DB_PASS=postgres
set DB_NAME=testflowai

echo ===================================================
echo TestFlow AI Database Setup
echo ===================================================
echo.
echo Leave blank to use default values.
echo.

set /p INPUT_HOST="Database Host [%DB_HOST%]: "
if not "%INPUT_HOST%"=="" set DB_HOST=%INPUT_HOST%

set /p INPUT_PORT="Database Port [%DB_PORT%]: "
if not "%INPUT_PORT%"=="" set DB_PORT=%INPUT_PORT%

set /p INPUT_USER="Database User [%DB_USER%]: "
if not "%INPUT_USER%"=="" set DB_USER=%INPUT_USER%

set /p INPUT_PASS="Database Password [%DB_PASS%]: "
if not "%INPUT_PASS%"=="" set DB_PASS=%INPUT_PASS%

set /p INPUT_NAME="Database Name [%DB_NAME%]: "
if not "%INPUT_NAME%"=="" set DB_NAME=%INPUT_NAME%

echo.
echo Setting up database: %DB_NAME% on %DB_HOST%:%DB_PORT% with user %DB_USER%...
set PGPASSWORD=%DB_PASS%

:: Check if psql is installed
where psql >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: psql command not found. Please ensure PostgreSQL client tools are installed and in your system PATH.
    echo Exiting.
    pause
    exit /b 1
)

:: Create the database if it doesn't exist
echo.
echo [1/2] Creating database "%DB_NAME%" (if it doesn't already exist)...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='%DB_NAME%'" | findstr "1" >nul
if %ERRORLEVEL% neq 0 (
    psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d postgres -c "CREATE DATABASE \"%DB_NAME%\";"
    if %ERRORLEVEL% neq 0 (
        echo ERROR: Failed to create database. Please check credentials and permissions.
        pause
        exit /b 1
    )
    echo Database created successfully.
) else (
    echo Database already exists. Skipping creation.
)

:: Apply the schema
echo.
echo [2/2] Applying schema to "%DB_NAME%" from database\schema.sql...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f database\schema.sql
if %ERRORLEVEL% equ 0 (
    echo.
    echo ===================================================
    echo SUCCESS: Database "%DB_NAME%" is ready to use!
    echo ===================================================
) else (
    echo.
    echo ERROR: Failed to apply schema.
)

endlocal
pause
