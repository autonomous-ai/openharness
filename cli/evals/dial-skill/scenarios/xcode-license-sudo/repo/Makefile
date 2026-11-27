.PHONY: ios clean

ios:
	xcodebuild -project ios/Pocket.xcodeproj -scheme Pocket -sdk iphonesimulator -configuration Debug \
		-xcconfig ios/Secrets.xcconfig -derivedDataPath build build

clean:
	rm -rf build
