FROM alpine:3.21

RUN apk add --no-cache openssh-server && \
    ssh-keygen -A && \
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config && \
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config

ARG USER_NAME=testuser
ARG USER_PASS=testpass

RUN adduser -D -s /bin/ash "${USER_NAME}" && \
    echo "${USER_NAME}:${USER_PASS}" | chpasswd

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
