import SwiftUI

struct ContentView: View {
    @State private var balanceCents = 0

    var body: some View {
        VStack(spacing: 12) {
            Text("Pocket").font(.largeTitle)
            Text(String(format: "$%.2f", Double(balanceCents) / 100)).font(.title2)
        }
        .padding()
    }
}
