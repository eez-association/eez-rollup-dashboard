FROM nginx:1.27-alpine
COPY landing/nginx.conf /etc/nginx/nginx.conf
COPY landing/index.html /usr/share/nginx/html/index.html
COPY landing/style.css /usr/share/nginx/html/network-assets/style.css
COPY src/styles/brand/eez.css src/styles/brand/*.woff2 src/styles/brand/eez-logo.svg src/styles/brand/eez-icon.svg src/styles/brand/gnosis-icon.svg src/styles/brand/ethereum-icon.svg src/styles/brand/OFL-*.txt /usr/share/nginx/html/network-assets/
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
