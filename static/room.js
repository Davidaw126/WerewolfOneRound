
$(document).ready(function(){

})

function invert(index){
        let checkbox = document.getElementById(index)
        if(checkbox.classList.contains("check")){
             checkbox.classList.add('basic');
             checkbox.classList.add('black');
             checkbox.classList.remove('check');
             checkbox.classList.remove('green');
        }else{
           checkbox.classList.remove('basic');
           checkbox.classList.remove('black');
           checkbox.classList.add('check');
           checkbox.classList.add('green');

        }

	}

function handleData()
{
            let formData = {
			};

            for (let i = 1; i <=21; i++) {
                let input = document.getElementById(i)
                if(input.classList.contains("check") ){
                    formData[input.value] =  "1" ;
                }

            }
            formData["普通狼人"] = document.getElementById("普通狼人").value;
            formData["普通村民"] = document.getElementById("普通村民").value;
            console.log(formData)

            $.ajax({
			  type: "POST",
			  url: "http://172.31.42.104:5000/room/settings",
			  data: formData,
			  dataType: "json",
			  encode: true,
			}).done(function (data) {
			    window.location.href="game"
			});
}


function updateNum(button, id){
    let oldValue =  document.getElementById(id).value;
    let newVal = 0;

      if (button.value == "up") {

          newVal = parseInt(oldValue) + 1;
        } else {
            if (oldValue > 0) {
              newVal = parseFloat(oldValue) - 1;
            } else {
              newVal = 0;
            }
      }

      document.getElementById(id).value = newVal;

}