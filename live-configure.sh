#!/bin/sh
FILE=$(ls /usr/share/nginx/html/assets/index*.js)
echo "update live JMAP_SERVER from mail.tb.pro to ${JMAP_SERVER} in ${FILE}"

cp "${FILE}" "/tmp/index.js"
sed -i 's/mail\.tb\.pro/'${JMAP_SERVER}'/g' /tmp/index.js
cat /tmp/index.js > "${FILE}"
