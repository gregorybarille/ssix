FROM alpine:3.21

# openssh-server provides sshd; openssh-sftp-server provides the SFTP
# subsystem (used by SSX's `scp_download` for the pre-stat call); the
# `openssh` meta-package pulls in the `scp` client binary that
# libssh2's `scp_send` execs as `scp -t <path>` on the remote side.
# Without scp/sftp the SCP/SFTP IPC commands fail in confusing ways
# (libssh2 reports the channel write as success even though the file
# is silently discarded; sftp.stat returns "no such file").
RUN apk add --no-cache openssh-server openssh-sftp-server openssh && \
    ssh-keygen -A && \
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config && \
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config && \
    sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config

ARG USER_NAME=testuser
ARG USER_PASS=testpass

RUN adduser -D -s /bin/ash "${USER_NAME}" && \
    echo "${USER_NAME}:${USER_PASS}" | chpasswd

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
