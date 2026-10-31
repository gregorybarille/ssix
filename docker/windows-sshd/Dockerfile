# escape=`
# A Windows OpenSSH server for the script tests (`remote_script::live` in
# src-tauri). Windows containers only: build and run it on a Windows host
# whose kernel matches the base image (CI uses windows-2022).
FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

ARG OPENSSH_VERSION=v9.5.0.0p1-Beta
ARG SSH_USER=ssix
# Windows refuses a password that contains the user name.
ARG SSH_PASSWORD=Remote-Run-2026!

# No double quotes: Docker's Windows shell form strips them.
RUN Invoke-WebRequest -UseBasicParsing ('https://github.com/PowerShell/Win32-OpenSSH/releases/download/' + $env:OPENSSH_VERSION + '/OpenSSH-Win64.zip') -OutFile C:\openssh.zip; `
    Expand-Archive C:\openssh.zip -DestinationPath $env:ProgramFiles; `
    Remove-Item C:\openssh.zip; `
    & (Join-Path $env:ProgramFiles 'OpenSSH-Win64\install-sshd.ps1'); `
    Set-Service sshd -StartupType Automatic; `
    New-LocalUser -Name $env:SSH_USER -PasswordNeverExpires -Password (ConvertTo-SecureString $env:SSH_PASSWORD -AsPlainText -Force) | Out-Null

EXPOSE 22

CMD ["powershell", "-NoProfile", "-Command", "Start-Service sshd; while ($true) { Start-Sleep -Seconds 3600 }"]
