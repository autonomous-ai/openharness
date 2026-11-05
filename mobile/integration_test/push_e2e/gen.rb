# Writes the runner's Xcode project: a UI test bundle with no host app, driving the installed app by
# its bundle id (PushE2E.swift). Usage: ruby gen.rb <dir> <PushE2E.swift>
require 'xcodeproj'

dir, source = ARGV
project = Xcodeproj::Project.new(File.join(dir, 'PushE2E.xcodeproj'))
target = project.new_target(:ui_test_bundle, 'PushE2E', :ios, '17.0')
target.add_file_references([project.main_group.new_file(File.expand_path(source))])
target.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'ai.autonomous.harness.pushe2e'
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.save_as(project.path, 'PushE2E', true)
