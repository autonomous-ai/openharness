"""Original native Manim scenes for checking the identity of saved video frames."""
from manim import Circle, Scene, Square, LEFT, RIGHT, linear


class Alpha(Scene):
    def construct(self):
        self.camera.background_color = "#101e2b"
        self.next_section("A square crosses")
        shape = Square(side_length=2, color="#ff7758", fill_opacity=1).shift(LEFT * 3)
        self.add(shape)
        self.play(shape.animate.shift(RIGHT * 6).rotate(1.2), run_time=2, rate_func=linear)


class Beta(Scene):
    def construct(self):
        self.camera.background_color = "#17261c"
        self.next_section("A circle rises")
        shape = Circle(radius=1.3, color="#8fe7b0", fill_opacity=1)
        self.add(shape)
        self.play(shape.animate.scale(.55).shift(LEFT * 2), run_time=2, rate_func=linear)
