
.PHONY: test
test: tsc
	node out/test.js

.PHONY: tsc
tsc:
	tsc --rootDir . --outDir out --module commonjs *.ts

.PHONY: server
server: tsc
	node out/server.js

.PHONY: watch
watch:
	tsc --rootDir . --outDir out --module commonjs --watch *.ts


.PHONY: clean
clean:
	rm -r out test.js sketch.js client.js server.js grbl.js

